import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DiagnosticReportService } from '../electron/services/diagnostic-reports.js';
import { uploadDiagnostic } from '../electron/services/diagnostic-upload.js';
import { DiagnosticController, diagnosticControllerInternals } from '../electron/services/diagnostic-controller.js';
import { APP_LOCALES } from '../shared/locale.js';
import { DIAGNOSTICS_COPY } from '../src/diagnostics-copy.js';

vi.mock('../electron/services/diagnostic-system.js', () => ({ collectDiagnosticSystemInfo: async () => ({}), collectGameWindowsEvents: async () => [] }));
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rotk-upload-')); roots.push(root);
  const directory = join(root, 'reports');
  const reports = new DiagnosticReportService({ directory, knownSecrets: () => ['a'.repeat(32)] });
  const session = await reports.beginSession({ launcherVersion: '2.0.8', serverLabel: 'Test', diagnosticCredentialHash: 'private-digest' });
  await reports.appendEvent(session.id, 'exception', { code: '0xC0000005', playerKey: 'a'.repeat(32) });
  await reports.finalizeSession(session.id, { exitCode: -1073741819 });
  await reports.collectSession(session.id);
  return { root, directory, reports, session };
}
it('prepares frozen redacted files without archive or private session data and detects tampering on resume', async () => {
  const { reports, session } = await fixture();
  const first = await reports.prepareUpload(session.id);
  expect(first.manifest.files.length).toBeGreaterThan(1);
  expect(first.manifest.files.some(f => f.name === 'session.json' || f.name.endsWith('.zip'))).toBe(false);
  for (let i = 0; i < first.paths.length; i++) {
    const data = await readFile(first.paths[i]);
    expect(data.toString()).not.toContain('a'.repeat(32));
    expect(data.toString()).not.toContain('private-digest');
    expect(createHash('sha256').update(data).digest('hex')).toBe(first.manifest.files[i].sha256);
  }
  expect(await reports.prepareUpload(session.id)).toEqual(first);
  await writeFile(first.paths[0], 'tampered'); await expect(reports.prepareUpload(session.id)).rejects.toThrow('changed');
});
it('sends only to pinned origins, resumes acknowledged files and validates completion', async () => {
  const { reports, session } = await fixture(), prepared = await reports.prepareUpload(session.id), remoteId = randomUUID();
  const received: number[] = [];
  const transport: NonNullable<Parameters<typeof uploadDiagnostic>[3]> = async (url, method, token, body, bytes) => {
    expect(url.origin).toBe('https://rotk.app');
    if (url.pathname.endsWith('/reports')) return { id: remoteId, token: 'b'.repeat(64), received: [0], complete: false };
    expect(token).toBe('b'.repeat(64));
    if (method === 'PUT') {
      const index = Number(url.pathname.split('/').at(-1)); received.push(index);
      const chunks = []; if (typeof body !== 'string') for await (const chunk of body) chunks.push(chunk);
      expect(Buffer.concat(chunks).length).toBe(bytes); return { received: index };
    }
    return { id: remoteId, complete: true };
  };
  await expect(uploadDiagnostic(prepared, 'https://rotk.app', 'a'.repeat(32), transport)).resolves.toBe(remoteId);
  expect(received).not.toContain(0);
  await expect(uploadDiagnostic(prepared, 'https://evil.invalid', 'a'.repeat(32), transport)).rejects.toThrow('destination');
  await expect(uploadDiagnostic(prepared, 'https://rotk.app', 'a'.repeat(32), async () => ({ id: '../../evil' }))).rejects.toThrow('receipt');
});
it('old Debug recordings have no upload consent and are never sent automatically', async () => {
  const { directory, reports, session } = await fixture();
  await reports.updateSession(session.id, { debugSessionEnabled: true });
  const upload = vi.fn(async () => randomUUID());
  const controller = new DiagnosticController({ directory, helperPath: 'unavailable.exe', knownSecrets: () => [], onChange: () => {}, uploadSession: upload });
  await controller.initialize(false, true);
  expect(upload).not.toHaveBeenCalled();
});
it('new opted-in sessions upload on exit and preserve a remote receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rotk-upload-controller-')); roots.push(root);
  const remoteId = randomUUID(), upload = vi.fn(async () => remoteId), onDebugSent = vi.fn();
  const controller = new DiagnosticController({ directory: join(root, 'reports'), helperPath: 'unavailable.exe', knownSecrets: () => [], onChange: () => {}, uploadSession: upload, onDebugSent });
  await controller.initialize(false, true);
  const launch = await controller.beginLaunch({ launcherVersion: '2.0.8', serverLabel: 'Test' });
  await launch.hooks.onExit(0, null);
  expect(upload).toHaveBeenCalledOnce(); expect(controller.debugState().fileName).toBe(remoteId);
  // One report per opt-in: the next game is not recorded unless Debug is ticked again.
  expect(controller.debugState()).toMatchObject({ enabled: false, status: 'ready' });
  expect(onDebugSent).toHaveBeenCalledOnce();
});
it('an interrupted opted-in session is collected and uploaded on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rotk-upload-interrupted-')); roots.push(root);
  const directory = join(root, 'reports');
  // The launcher or Windows stopped during the game: the session was never finalized.
  const interrupted = await new DiagnosticReportService({ directory })
    .beginSession({ launcherVersion: '2.0.38', serverLabel: 'Test', debugSessionEnabled: true, diagnosticUploadConsent: 1 });
  const remoteId = randomUUID(), onDebugSent = vi.fn();
  const controller: DiagnosticController = new DiagnosticController({ directory, helperPath: 'unavailable.exe', knownSecrets: () => [], onChange: () => {}, onDebugSent,
    uploadSession: async (id) => { await controller.reports.prepareUpload(id); return remoteId; } });
  await controller.initialize(false, true);
  // Network recovery is not awaited by initialize.
  await vi.waitFor(() => expect(controller.debugState().status).not.toBe('preparing'), { timeout: 10_000 });
  expect(controller.debugState()).toMatchObject({ enabled: false, status: 'ready', fileName: remoteId });
  expect(onDebugSent).toHaveBeenCalledOnce();
  const record = await controller.reports.getReport(interrupted.id);
  expect(record.summary.kind).toBe('interrupted');
  expect(record.context.debugRemoteReportId).toBe(remoteId);
  // Without an exit boundary, shared client logs are left out on purpose.
  expect(record.issues.some(issue => issue.reason === 'session_end_log_boundary_unavailable')).toBe(true);
}, 20_000); // A real collection and upload preparation can exceed 5s on Windows CI.
it('keeps why a report was not sent after exit and after the start-up retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rotk-upload-failure-')); roots.push(root);
  const directory = join(root, 'reports'), onDebugFailure = vi.fn(), onDebugSent = vi.fn(), refused = new Error('Diagnostic upload refused (413)');
  const controller = new DiagnosticController({ directory, helperPath: 'unavailable.exe', knownSecrets: () => [], onChange: () => {}, onDebugFailure, onDebugSent,
    uploadSession: async () => { throw refused; } });
  await controller.initialize(false, true);
  const launch = await controller.beginLaunch({ launcherVersion: '2.0.38', serverLabel: 'Test' });
  await launch.hooks.onExit(0, null);
  expect(controller.debugState()).toMatchObject({ enabled: true, status: 'error', failure: { reason: 'rejected', httpStatus: 413 } });
  // Debug stays on so the next launcher start retries the report.
  expect(onDebugSent).not.toHaveBeenCalled();
  expect(onDebugFailure).toHaveBeenCalledWith('debug-export-failed', 'rejected', refused);
  const restarted = new DiagnosticController({ directory, helperPath: 'unavailable.exe', knownSecrets: () => [], onChange: () => {}, onDebugFailure,
    uploadSession: async () => { throw new Error('Diagnostic upload timeout'); } });
  await restarted.initialize(false, true);
  await vi.waitFor(() => expect(restarted.debugState().status).not.toBe('preparing'));
  expect(restarted.debugState()).toMatchObject({ status: 'error', failure: { reason: 'timeout', httpStatus: null } });
  expect(onDebugFailure).toHaveBeenLastCalledWith('debug-upload-failed', 'timeout', expect.any(Error));
});
it('maps upload errors to stable reasons', () => {
  const { debugFailure } = diagnosticControllerInternals;
  const coded = (message: string, code: string, syscall?: string) => Object.assign(new Error(message), { code, syscall });
  expect(debugFailure(coded("EACCES: permission denied, open 'report.json'", 'EACCES', 'open')).reason).toBe('collection');
  expect(debugFailure(new Error('Upload evidence changed')).reason).toBe('collection');
  expect(debugFailure(new Error('Diagnostic upload timeout')).reason).toBe('timeout');
  expect(debugFailure(new Error('Diagnostic upload time budget exceeded')).reason).toBe('timeout');
  for (const code of ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'CERT_HAS_EXPIRED']) expect(debugFailure(coded('connection failed', code)).reason).toBe('network');
  // A firewall that blocks the launcher's socket.
  expect(debugFailure(coded('connect EACCES 1.2.3.4:443', 'EACCES', 'connect')).reason).toBe('network');
  expect(debugFailure(new Error('Diagnostic upload refused (413)'))).toEqual({ reason: 'rejected', httpStatus: 413 });
  expect(debugFailure(new Error('Invalid diagnostic receipt'))).toEqual({ reason: 'rejected', httpStatus: null });
  expect(debugFailure(new Error('Diagnostic account changed')).reason).toBe('account-changed');
  expect(debugFailure('unexpected').reason).toBe('other');
});
it('every reason has a translated cause under "Report not sent"', () => {
  const english = DIAGNOSTICS_COPY.en.debug.failure;
  expect(Object.keys(english).sort()).toEqual(['account-changed', 'collection', 'network', 'other', 'rejected', 'timeout']);
  for (const locale of APP_LOCALES) {
    const failure = DIAGNOSTICS_COPY[locale].debug.failure;
    expect(Object.keys(failure).sort()).toEqual(Object.keys(english).sort());
    for (const [reason, text] of Object.entries(failure)) {
      expect(text).toMatch(/\S/);
      if (locale !== 'en') expect(text).not.toBe(english[reason as keyof typeof english]);
    }
  }
});
