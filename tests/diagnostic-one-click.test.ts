import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticController } from '../electron/services/diagnostic-controller.js';
import type { NativeObserverOptions } from '../electron/services/diagnostic-observer.js';
import type { DiagnosticSessionContext } from '../electron/services/diagnostic-reports.js';

type ObserverMock = {
  options: NativeObserverOptions;
  attached: boolean;
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  drain: ReturnType<typeof vi.fn<() => Promise<void>>>;
  snapshot: ReturnType<typeof vi.fn<(mode: 'standard' | 'full') => Promise<void>>>;
  captureOnce: ReturnType<typeof vi.fn<(mode: 'standard' | 'full') => Promise<void>>>;
  isAttached(): boolean;
};
const mocks = vi.hoisted(() => ({
  observers: [] as ObserverMock[],
  collectSystem: vi.fn<() => Promise<Record<string, unknown>>>(),
  windowsEvents: vi.fn<() => Promise<unknown[]>>(),
}));
vi.mock('../electron/services/diagnostic-system.js', () => ({
  collectDiagnosticSystemInfo: mocks.collectSystem,
  collectGameWindowsEvents: mocks.windowsEvents,
}));
vi.mock('../electron/services/diagnostic-observer.js', () => ({
  DiagnosticObserver: class implements ObserverMock {
    attached = false;
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    drain = vi.fn(async () => undefined);
    snapshot = vi.fn(async (_mode: 'standard' | 'full') => undefined);
    captureOnce = vi.fn(async (_mode: 'standard' | 'full') => undefined);
    constructor(readonly options: NativeObserverOptions) { mocks.observers.push(this); }
    isAttached(): boolean { return this.attached; }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const roots: string[] = [];
beforeEach(() => {
  mocks.observers.length = 0;
  mocks.collectSystem.mockReset().mockResolvedValue({ os: 'Windows fixture', memoryBytes: 8 * 1024 ** 3 });
  mocks.windowsEvents.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(join(tmpdir(), 'rotk-one-click-test-')))) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'rotk-one-click-test-')); roots.push(root);
  const options = { directory: join(root, 'reports'), helperPath: join(root, 'missing-helper.exe'),
    knownSecrets: () => ['fixture-private-secret'], onChange: vi.fn() };
  const controller = new DiagnosticController(options);
  await controller.initialize(enabled);
  const context: DiagnosticSessionContext = { launcherVersion: '2.0.7', serverLabel: 'TEST ONLY', serverId: 'fixture', playerName: 'FixturePlayer' };
  return { root, controller, context, options, destination: join(root, 'Downloads', 'ROTK-Rapports') };
}

function unzip(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const files = new Map<string, Buffer>();
      zip.on('error', reject); zip.on('end', () => resolve(files));
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (readError, stream) => {
          if (readError || !stream) { reject(readError); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk)); stream.on('error', reject);
          stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}
const json = (files: Map<string, Buffer>, name: string) => JSON.parse(files.get(name)!.toString('utf8'));
async function completedSession(f: Awaited<ReturnType<typeof fixture>>, code: number | null, patch: Record<string, unknown> = {}) {
  // Sessions need distinct recorded timestamps to make the chronology explicit.
  await new Promise((resolve) => setTimeout(resolve, 3));
  const session = await f.controller.reports.beginSession({ ...f.context, ...patch });
  await f.controller.reports.finalizeSession(session.id, { exitCode: code });
  await f.controller.reports.collectSession(session.id);
  return session;
}

describe('one-click player crash reports', () => {
  it('selects the latest real game rather than an older known crash or newer manual reports, and preserves exit zero', async () => {
    const f = await fixture();
    const oldCrash = await completedSession(f, -1073741819);
    const latestGame = await completedSession(f, 0, { serverLabel: 'LATEST GAME' });
    await completedSession(f, null, { manual: true });
    const manualByKind = await completedSession(f, null);
    await f.controller.reports.updateSession(manualByKind.id, { kind: 'manual' });

    const exported = await f.controller.reportCrash(f.destination, f.context);
    const files = await unzip(exported.path), report = json(files, 'report.json');
    expect(report.summary).toMatchObject({ id: latestGame.id, kind: 'exit', exitCodeHex: '0x00000000', serverLabel: 'LATEST GAME' });
    expect(report.exit).toMatchObject({ code: 0, unsignedCode: 0 });
    expect(report.context.playerReportedCrash).toBe(true);
    expect(Number.isFinite(Date.parse(report.context.playerReportedAt))).toBe(true);
    expect((await f.controller.reports.getReport(oldCrash.id)).context.playerReportedCrash).toBeUndefined();
    expect(await readFile(join(latestGame.directory, 'events.jsonl'), 'utf8')).toContain('player_reported_crash');
    expect(files.get('NOTES.txt')!.toString()).toContain('crash');
    expect(exported.path).toBe(join(f.destination, exported.fileName));
    expect(exported.fileName).toMatch(/^ROTK-crash-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}-[a-f0-9]{8}\.zip$/);
  }, 30_000);

  it('exports existing dumps and sanitized game/native evidence in a valid ZIP with correct manifest hashes', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    const directory = f.controller.reports.getDirectory(launch.id);
    const dump = Buffer.from('MDMP\0FIXTURE MEMORY\0\xff', 'latin1');
    await writeFile(join(directory, 'fatal-fixture.dmp'), dump);
    await writeFile(join(directory, 'snapshot-full-fixture.dmp'), dump);
    await writeFile(join(directory, 'unfinished.dmp.partial'), 'INCOMPLETE');
    await writeFile(join(directory, 'native-events.jsonl'), JSON.stringify({ event: 'exception', firstChance: false, code: '0xC0000005', address: '0x140001234' }) + '\n');
    launch.hooks.onOutput('stderr', 'FixturePlayer characterId=0x12345678 sessionid=fixture-private-secret');
    await launch.hooks.onExit(-1073741819, null);

    const exported = await f.controller.reportCrash(f.destination, f.context), files = await unzip(exported.path);
    expect(files.get('dumps/fatal-fixture.dmp')).toEqual(dump);
    expect(files.get('dumps/snapshot-full-fixture.dmp')).toEqual(dump);
    expect([...files.keys()].some((name) => name.endsWith('.partial'))).toBe(false);
    const text = [...files].filter(([name]) => !name.endsWith('.dmp')).map(([, value]) => value.toString()).join('\n');
    expect(text).toContain('characterId=0x12345678');
    expect(text).toContain('0x140001234');
    expect(text).not.toContain('fixture-private-secret');
    const report = json(files, 'report.json');
    expect(report.summary).toMatchObject({ id: launch.id, kind: 'crash', exitCodeHex: '0xC0000005', dumpCount: 2, hasFullDump: true });
    const manifest = json(files, 'manifest.json');
    expect(manifest.containsUnredactedProcessMemory).toBe(true);
    expect(manifest.files).toHaveLength(files.size - 1);
    for (const item of manifest.files) {
      const content = files.get(item.name)!;
      expect(content.length).toBe(item.bytes);
      expect(createHash('sha256').update(content).digest('hex')).toBe(item.sha256);
    }
  });

  it('recovers native crash evidence after launcher restart even if process exit was never recorded', async () => {
    const f = await fixture(), session = await f.controller.reports.beginSession(f.context);
    const dump = Buffer.from('MDMP\0RECOVERED FIXTURE', 'latin1');
    await writeFile(join(session.directory, 'fatal-recovered.dmp'), dump);
    await writeFile(join(session.directory, 'native-events.jsonl'), JSON.stringify({ event: 'exception', firstChance: false, code: '0xC0000005' }) + '\n');
    const restarted = new DiagnosticController(f.options);
    await restarted.initialize(true);
    expect((await restarted.state()).recordingId).toBeNull();

    const exported = await restarted.reportCrash(f.destination, f.context), files = await unzip(exported.path);
    const report = json(files, 'report.json');
    expect(report.summary).toMatchObject({ id: session.id, kind: 'crash', dumpCount: 1 });
    expect(report.exit).toBeNull();
    expect(report.context.playerReportedCrash).toBe(true);
    expect(files.get('dumps/fatal-recovered.dmp')).toEqual(dump);
    expect(mocks.observers).toHaveLength(0);
  });

  it('waits for finalization and late native/WER evidence instead of snapshotting an exited game', async () => {
    const windows = deferred<unknown[]>(); mocks.windowsEvents.mockReturnValue(windows.promise);
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    const exited = launch.hooks.onExit(-1073741819, null);
    await vi.waitFor(() => expect(mocks.windowsEvents).toHaveBeenCalledOnce());
    let completed = false;
    const exporting = f.controller.reportCrash(f.destination, f.context).then((result) => { completed = true; return result; });
    await vi.waitFor(() => expect(f.controller.isBusy()).toBe(true));
    expect(completed).toBe(false);
    expect(mocks.observers[0]!.snapshot).not.toHaveBeenCalled();
    expect(mocks.observers).toHaveLength(1);
    const dump = Buffer.from('MDMP\0LATE FIXTURE', 'latin1');
    await writeFile(join(f.controller.reports.getDirectory(launch.id), 'fatal-late.dmp'), dump);
    windows.resolve([{ provider: 'Application Error', eventId: 1000, fixtureEvidence: 'ACCESS VIOLATION' }]);
    const [, exported] = await Promise.all([exited, exporting]);
    const files = await unzip(exported.path), report = json(files, 'report.json');
    expect(report.summary).toMatchObject({ id: launch.id, kind: 'crash', exitCodeHex: '0xC0000005' });
    expect(report.context.windowsEvents).toEqual([{ provider: 'Application Error', eventId: 1000, fixtureEvidence: 'ACCESS VIOLATION' }]);
    expect(files.get('dumps/fatal-late.dmp')).toEqual(dump);
    expect((await f.controller.state())).toMatchObject({ busy: false, recordingId: null });
  });

  it.each(['empty', 'manual-only'] as const)('produces a system fallback for %s history without inventing a native crash', async (history) => {
    const f = await fixture();
    if (history === 'manual-only') await f.controller.capture({ mode: 'standard', description: 'Older manual report' }, f.context);
    const before = await f.controller.reports.listReports();
    const exported = await f.controller.reportCrash(f.destination, f.context), files = await unzip(exported.path);
    const report = json(files, 'report.json');
    expect(before.some((item) => item.id === report.summary.id)).toBe(false);
    expect(report.summary).toMatchObject({ kind: 'manual', exitCodeHex: null, dumpCount: 0 });
    expect(report.exit.code).toBeNull();
    expect(report.context).toMatchObject({ manual: true, playerReportedCrash: true, systemInfo: { os: 'Windows fixture' } });
    expect(report.summary.warnings.join(' ')).toMatch(/No game was running/);
    expect(mocks.observers).toHaveLength(0);
    expect((await f.controller.state()).busy).toBe(false);
  });

  it('captures the active session in standard mode and rejects another operation until the ZIP is finished', async () => {
    const f = await fixture(), old = await completedSession(f, -1073741819);
    const launch = await f.controller.beginLaunch(f.context); launch.hooks.onSpawned(4242);
    const observer = mocks.observers[0]!; observer.attached = true;
    const snapshot = deferred<void>(); observer.snapshot.mockReturnValue(snapshot.promise);
    const exporting = f.controller.reportCrash(f.destination, f.context);
    await vi.waitFor(() => expect(observer.snapshot).toHaveBeenCalledWith('standard'));
    expect(f.controller.isBusy()).toBe(true);
    await expect(f.controller.reportCrash(f.destination, f.context)).rejects.toThrow(/already running/);
    await expect(f.controller.capture({ mode: 'full', description: '' }, f.context)).rejects.toThrow(/already running/);
    await expect(f.controller.exportReport(old.id, join(f.root, 'other.zip'), { includeDumps: false, description: '' })).rejects.toThrow(/already running/);
    const dump = Buffer.from('MDMP\0ACTIVE SNAPSHOT', 'latin1');
    await writeFile(join(f.controller.reports.getDirectory(launch.id), 'snapshot-standard.dmp'), dump);
    snapshot.resolve();
    const exported = await exporting, files = await unzip(exported.path);
    expect(json(files, 'report.json').summary).toMatchObject({ id: launch.id, status: 'recording' });
    expect(files.get('dumps/snapshot-standard.dmp')).toEqual(dump);
    expect((await f.controller.state())).toMatchObject({ busy: false, recordingId: launch.id });
    expect(observer.stop).not.toHaveBeenCalled();
    await launch.hooks.onExit(0, null);
  });

  it('releases the busy lock after a destination write failure and succeeds when retried', async () => {
    const f = await fixture(), session = await completedSession(f, 0);
    const blockedDestination = join(f.root, 'destination-is-a-file');
    await writeFile(blockedDestination, 'KEEP EXISTING FILE');
    await expect(f.controller.reportCrash(blockedDestination, f.context)).rejects.toThrow();
    expect(f.controller.isBusy()).toBe(false);
    expect(await readFile(blockedDestination, 'utf8')).toBe('KEEP EXISTING FILE');
    const exported = await f.controller.reportCrash(f.destination, f.context);
    expect(json(await unzip(exported.path), 'report.json').summary.id).toBe(session.id);
    expect((await f.controller.state()).busy).toBe(false);
  });

  it('creates a unique file on each click and never overwrites an earlier archive', async () => {
    const f = await fixture(), session = await completedSession(f, 0);
    const first = await f.controller.reportCrash(f.destination, f.context), firstBytes = await readFile(first.path);
    const second = await f.controller.reportCrash(f.destination, f.context);
    expect(second.path).not.toBe(first.path);
    expect(second.fileName).not.toBe(first.fileName);
    expect(await readFile(first.path)).toEqual(firstBytes);
    expect(json(await unzip(first.path), 'report.json').summary.id).toBe(session.id);
    expect(json(await unzip(second.path), 'report.json').summary.id).toBe(session.id);
  });

  it('holds the lock during ZIP writing and releases it if the archive writer fails', async () => {
    const f = await fixture(), session = await completedSession(f, 0);
    const writing = deferred<void>();
    const exportSpy = vi.spyOn(f.controller.reports, 'exportReport').mockImplementationOnce(async () => {
      await writing.promise;
      throw new Error('Fixture disk full while writing ZIP');
    });
    const exporting = f.controller.reportCrash(f.destination, f.context);
    await vi.waitFor(() => expect(exportSpy).toHaveBeenCalledOnce());
    expect(f.controller.isBusy()).toBe(true);
    await expect(f.controller.reportCrash(f.destination, f.context)).rejects.toThrow(/already running/);
    writing.resolve();
    await expect(exporting).rejects.toThrow('Fixture disk full while writing ZIP');
    expect(f.controller.isBusy()).toBe(false);
    const exported = await f.controller.reportCrash(f.destination, f.context);
    expect(json(await unzip(exported.path), 'report.json').summary.id).toBe(session.id);
    expect((await f.controller.state()).busy).toBe(false);
  });
});
