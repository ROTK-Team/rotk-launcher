import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream, type Stats } from 'node:fs';
import { appendFile, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import * as yazl from 'yazl';
import type { DiagnosticCaptureStatus, DiagnosticReportKind, DiagnosticReportSummary } from '../../shared/diagnostics.js';
import { redactDiagnosticText, sanitizeDiagnosticValue } from './diagnostic-redaction.js';
import type { PreparedUpload } from './diagnostic-upload.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 20 * 1024 * 1024;
const FILE_COUNT = 40;
const DEBUG_JSONL_LIMIT = 16 * 1024 * 1024;
const DEBUG_SUMMARY_LIMIT = 64 * 1024;
const DEBUG_TOTAL_LIMIT = 66 * 1024 * 1024;
const DEBUG_LINE_LIMIT = 64 * 1024;
const DEBUG_FILES = new Map([
  ['performance.jsonl.1', DEBUG_JSONL_LIMIT], ['performance.jsonl', DEBUG_JSONL_LIMIT],
  ['performance-summary.json', DEBUG_SUMMARY_LIMIT],
  ['frame-times.jsonl.1', DEBUG_JSONL_LIMIT], ['frame-times.jsonl', DEBUG_JSONL_LIMIT],
  ['frame-times-summary.json', DEBUG_SUMMARY_LIMIT],
]);
const RETENTION_BYTES = 5 * 1024 ** 3;
// rotk-shotgun-sprint.log says which gameplay patches installed or were refused.
// LongFrames.log is the game's own breakdown of each long frame by engine section.
const ROOT_LOG_NAMES = new Set(['rotk-crouch-parity.log', 'rotk-shotgun-sprint.log', 'rotk-vivox-v5-compat.log', 'rotk-vivox-hook.log', 'rotk-vivoxproxy.log', 'steam_api64.log', 'vivox.log', 'vivoxsdk_x64.log', 'h1z1.log', 'client.log', 'game.log', 'connection.log', 'debug.txt']);
const GAME_LOG_NAMES = new Set(['killfeed.log', 'longframes.log', 'gfxwrap.log', 'uidb.log', 'failedloadassets.log', 'failedsyncloadassets.log', 'contentpackerrors.txt']);
// The game chooses variable log component names. Within its dedicated log
// directories accept .log rotations; structured/text reports require a known
// diagnostic prefix. Configuration and credentials remain explicitly excluded.
const LOG_NAME = /\.log(?:\.[0-9]{1,3})?$|^(?:h1z1|client|game|vivox|error|fail|connection|network|resource|performance|rotk|crash|runtime|console|launch|log|debug|last-session-diagnostics|[0-9]{4})[^\\/]*\.(?:txt|xml|json)(?:\.[0-9])?$/i;
const FORBIDDEN_LOG = /(?:password|credential|player[-_]?key|auth|ticket|token|config|manifest|environment)/i;

export interface DiagnosticSessionContext {
  launcherVersion: string;
  serverLabel: string;
  serverId?: string;
  playerName?: string | null;
  installId?: string;
  installationRoot?: string;
  logsRoot?: string;
  assetPackVersion?: string;
  role?: string;
  pid?: number;
  captureMode?: 'standard' | 'full';
  [key: string]: unknown;
}
export interface DiagnosticSessionPatch {
  pid?: number;
  captureStatus?: DiagnosticCaptureStatus;
  captureMode?: 'standard' | 'full';
  warnings?: string[];
  kind?: DiagnosticReportKind;
  [key: string]: unknown;
}
interface SourceSnapshot { path: string; root: string; label: string; size: number; mtimeMs: number; ino: number; prefix: string; }
interface ExitSourceSnapshot extends SourceSnapshot { tailStart: number; tailHash: string; baselineOffset: number | null; }
interface Issue { source: string; reason: string; }
export interface DiagnosticReportRecord {
  schemaVersion: 1;
  summary: DiagnosticReportSummary;
  context: DiagnosticSessionContext;
  timezoneOffsetMinutes: number;
  exit: { code: number | null; unsignedCode: number | null; hex: string | null; name: string | null; signal: string | null; error: string | null } | null;
  issues: Issue[];
  sources: SourceSnapshot[];
  /** Private immutable byte boundaries, captured before native/WER collection waits. */
  exitSources?: ExitSourceSnapshot[];
  exitSourcesCapturedAt?: string;
  collectionCompletedAt?: string;
}
const EXIT_NAMES: Record<string, string> = {
  '0xC0000005': 'ACCESS_VIOLATION', '0xC00000FD': 'STACK_OVERFLOW', '0xC000001D': 'ILLEGAL_INSTRUCTION',
  '0xC0000374': 'HEAP_CORRUPTION', '0xC0000409': 'STACK_BUFFER_OVERRUN_OR_FAIL_FAST',
  '0xC0000094': 'INTEGER_DIVIDE_BY_ZERO', '0xC0000096': 'PRIVILEGED_INSTRUCTION',
  '0x80000003': 'BREAKPOINT', '0xC0000135': 'DLL_NOT_FOUND', '0xC0000142': 'DLL_INIT_FAILED',
};
function inside(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function failureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? code : 'source_unavailable';
}
async function atomicJson(path: string, data: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
async function safeFile(path: string, root: string): Promise<Stats> {
  if (!inside(path, root)) throw new Error('outside_source_root');
  const rel = relative(root, path);
  let cursor = resolve(root);
  for (const piece of ['', ...rel.split(sep).filter(Boolean)]) {
    if (piece) cursor = join(cursor, piece);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('symbolic_link_skipped');
  }
  const info = await lstat(path);
  if (!info.isFile() || !inside(await realpath(path), await realpath(root))) throw new Error('unsafe_source');
  return info;
}
async function prefixHash(path: string, count: number): Promise<string> {
  const handle = await open(path, 'r');
  try { const b = Buffer.alloc(Math.min(count, 4096)); const { bytesRead } = await handle.read(b, 0, b.length, 0); return createHash('sha256').update(b.subarray(0, bytesRead)).digest('hex'); }
  finally { await handle.close(); }
}
async function boundedBytes(path: string, start: number, end: number): Promise<Buffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > FILE_LIMIT) throw new Error('invalid_log_boundary');
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(end - start);
    let consumed = 0;
    while (consumed < bytes.length) {
      const read = await handle.read(bytes, consumed, bytes.length - consumed, start + consumed);
      if (read.bytesRead === 0) throw new Error('source_changed_since_exit_boundary');
      consumed += read.bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}

export class DiagnosticReportService {
  private readonly directory: string;
  private readonly records = new Map<string, DiagnosticReportRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly active = new Set<string>();
  private initialized = false;
  private initialization: Promise<void> | null = null;
  constructor(private readonly options: { directory: string; onChange?: () => void; knownSecrets?: () => string[] }) {
    this.directory = resolve(options.directory);
  }
  getDirectory(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid diagnostic report identifier.');
    return join(this.directory, id);
  }
  private secrets(): string[] { return this.options.knownSecrets?.() ?? []; }
  private changed(): void { try { this.options.onChange?.(); } catch { /* A UI listener cannot invalidate a report. */ } }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const promise = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(id, promise);
    void promise.finally(() => { if (this.queues.get(id) === promise) this.queues.delete(id); }).catch(() => undefined);
    return promise;
  }
  private require(id: string): DiagnosticReportRecord {
    this.getDirectory(id);
    const record = this.records.get(id);
    if (!record) throw new Error('Diagnostic report not found.');
    return record;
  }
  private async persist(record: DiagnosticReportRecord): Promise<void> {
    const dir = this.getDirectory(record.summary.id);
    if ((await lstat(dir)).isSymbolicLink() || !inside(await realpath(dir), await realpath(this.directory))) throw new Error('Unsafe diagnostic directory.');
    await atomicJson(join(dir, 'session.json'), record);
    this.changed();
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeFromDisk();
    try { await this.initialization; } finally { this.initialization = null; }
  }
  private async initializeFromDisk(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('Diagnostic directory cannot be a link.');
    const dirs = await readdir(this.directory, { withFileTypes: true });
    for (const entry of dirs.filter((item) => ID.test(item.name)).slice(0, 200)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const path = join(this.getDirectory(entry.name), 'session.json');
        const info = await safeFile(path, this.directory);
        if (info.size > FILE_LIMIT) continue;
        const record = JSON.parse(await readFile(path, 'utf8')) as DiagnosticReportRecord;
        if (record.schemaVersion !== 1 || record.summary?.id !== entry.name || !record.context || !Array.isArray(record.sources) || !Array.isArray(record.issues)) continue;
        if (!Number.isFinite(Date.parse(record.summary.startedAt))) continue;
        if (record.summary.status === 'recording' || record.summary.status === 'collecting') {
          const observedExit = Boolean(record.summary.endedAt && record.exit);
          if (!observedExit) record.summary.kind = 'interrupted';
          record.summary.status = 'partial';
          record.summary.endedAt ??= new Date().toISOString();
          record.summary.warnings.push(observedExit
            ? 'Launcher report collection was interrupted after the observed game exit.'
            : 'Launcher recording was interrupted. This does not establish a game crash.');
          record.summary.captureStatus = 'unavailable';
          await this.persist(record);
        }
        this.records.set(entry.name, record);
      } catch { /* A malformed or inaccessible session must not hide other reports. */ }
    }
    this.initialized = true;
    await this.retention();
    this.changed();
  }
  private async sources(context: DiagnosticSessionContext): Promise<{ files: SourceSnapshot[]; issues: Issue[] }> {
    const files: SourceSnapshot[] = [], issues: Issue[] = [];
    const roots: { path: string; boundary: string; label: string; recursive: boolean; names?: ReadonlySet<string> }[] = [];
    if (context.logsRoot && context.installId && /^[A-Za-z0-9_-]{1,128}$/.test(context.installId)) {
      roots.push({ path: join(context.logsRoot, context.installId, 'local'), boundary: context.logsRoot, label: 'client-local', recursive: true },
        { path: join(context.logsRoot, context.installId, 'failure'), boundary: context.logsRoot, label: 'client-failure', recursive: true });
    }
    if (context.installationRoot) roots.push(
      { path: context.installationRoot, boundary: context.installationRoot, label: 'client-native', recursive: false },
      { path: join(context.installationRoot, 'Logs'), boundary: context.installationRoot, label: 'client-game', recursive: false, names: GAME_LOG_NAMES },
    );
    for (const source of roots) {
      let inspected = 0;
      const walk = async (directory: string, depth: number): Promise<void> => {
        const meta = await lstat(directory);
        if (!meta.isDirectory() || meta.isSymbolicLink()) { issues.push({ source: source.label, reason: 'linked_directory_skipped' }); return; }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (++inspected > 1000) { issues.push({ source: source.label, reason: 'directory_scan_limit' }); return; }
          if (entry.isSymbolicLink()) { issues.push({ source: source.label, reason: 'linked_source_skipped' }); continue; }
          const path = join(directory, entry.name);
          if (entry.isDirectory() && source.recursive && depth < 2) {
            if (FORBIDDEN_LOG.test(entry.name)) continue;
            await walk(path, depth + 1).catch(() => issues.push({ source: source.label, reason: 'subdirectory_unavailable' })); continue;
          }
          const knownName = entry.name.toLowerCase().replace(/\.[0-9]{1,3}$/, '');
          if (!entry.isFile() || (source.names ? !source.names.has(knownName) : source.recursive ? !LOG_NAME.test(entry.name) || FORBIDDEN_LOG.test(entry.name) : !ROOT_LOG_NAMES.has(entry.name.toLowerCase()))) continue;
          try {
            const info = await safeFile(path, source.boundary);
            files.push({ path, root: source.boundary, label: source.names ? `${source.label}-${entry.name}` : source.label, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, prefix: await prefixHash(path, info.size) });
          } catch (error) { issues.push({ source: source.label, reason: failureReason(error) }); }
        }
      };
      await walk(source.path, 0).catch((error) => issues.push({ source: source.label, reason: failureReason(error) }));
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (files.length > FILE_COUNT) issues.push({ source: 'client-logs', reason: 'file_count_limit' });
    return { files: files.slice(0, FILE_COUNT), issues };
  }
  async beginSession(context: DiagnosticSessionContext): Promise<{ id: string; directory: string }> {
    await this.initialize();
    const id = randomUUID(), directory = this.getDirectory(id);
    await mkdir(directory);
    const snapshot = await this.sources(context);
    const record: DiagnosticReportRecord = {
      schemaVersion: 1, context: structuredClone(context), timezoneOffsetMinutes: -new Date().getTimezoneOffset(), exit: null,
      issues: snapshot.issues, sources: snapshot.files,
      summary: { id, startedAt: new Date().toISOString(), endedAt: null, kind: 'manual', status: 'recording',
        launcherVersion: context.launcherVersion, serverLabel: context.serverLabel, playerName: context.playerName ?? null,
        exitCodeHex: null, durationMs: null, dumpCount: 0, hasFullDump: false, totalBytes: 0, captureStatus: 'pending', warnings: [] },
    };
    this.records.set(id, record); this.active.add(id);
    await this.persist(record);
    await this.appendEvent(id, 'session_started', { launcherVersion: context.launcherVersion, serverLabel: context.serverLabel });
    return { id, directory };
  }
  async updateSession(id: string, patch: DiagnosticSessionPatch): Promise<void> {
    return this.serial(id, async () => {
      const record = this.require(id);
      const { captureStatus, warnings, kind, ...context } = patch;
      Object.assign(record.context, structuredClone(context));
      if (captureStatus) record.summary.captureStatus = captureStatus;
      if (kind) record.summary.kind = kind;
      if (typeof context.playerName === 'string' || context.playerName === null) record.summary.playerName = context.playerName;
      if (typeof context.serverLabel === 'string') record.summary.serverLabel = context.serverLabel;
      if (warnings) record.summary.warnings.push(...warnings.map((warning) => redactDiagnosticText(warning, this.secrets())));
      record.summary.warnings = [...new Set(record.summary.warnings)].slice(-100);
      await this.persist(record);
    });
  }
  async appendEvent(id: string, event: string, data: unknown = {}): Promise<void> {
    return this.serial(id, async () => {
      const record = this.require(id);
      const path = join(this.getDirectory(id), 'events.jsonl');
      const info = await lstat(path).catch(() => null);
      if (info?.isSymbolicLink()) throw new Error('Unsafe event file.');
      const value = { at: new Date().toISOString(), event: redactDiagnosticText(event.slice(0, 128), this.secrets()), data: sanitizeDiagnosticValue(data, this.secrets()) };
      let line = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(line) > 64 * 1024) {
        value.data = { omitted: 'event_payload_exceeds_64KiB' }; line = JSON.stringify(value) + '\n';
        if (!record.issues.some((issue) => issue.reason === 'event_payload_truncated')) record.issues.push({ source: 'events.jsonl', reason: 'event_payload_truncated' });
      }
      if ((info?.size ?? 0) + Buffer.byteLength(line) > FILE_LIMIT) {
        if (!record.issues.some((issue) => issue.reason === 'event_log_limit')) {
          record.issues.push({ source: 'events.jsonl', reason: 'event_log_limit' }); await this.persist(record);
        }
        return;
      }
      await appendFile(path, line);
    });
  }
  async finalizeSession(id: string, result: { exitCode: number | null; signal?: string | null; error?: unknown; endedAt?: string }): Promise<void> {
    return this.serial(id, async () => {
      const record = this.require(id);
      if (result.endedAt !== undefined && !Number.isFinite(Date.parse(result.endedAt))) throw new Error('Invalid diagnostic exit timestamp.');
      const endedAt = result.endedAt === undefined ? new Date().toISOString() : new Date(result.endedAt).toISOString();
      const unsignedCode = result.exitCode === null ? null : result.exitCode >>> 0;
      const hex = unsignedCode === null ? null : `0x${unsignedCode.toString(16).padStart(8, '0').toUpperCase()}`;
      const name = hex ? EXIT_NAMES[hex] ?? (unsignedCode === 0 ? 'SUCCESS' : 'NONZERO_EXIT') : null;
      record.exit = { code: result.exitCode, unsignedCode, hex, name, signal: result.signal ?? null,
        error: result.error ? redactDiagnosticText(result.error instanceof Error ? result.error.message : String(result.error), this.secrets()) : null };
      record.summary.kind = result.error ? 'launch-error' : hex && EXIT_NAMES[hex] ? 'crash' : 'exit';
      record.summary.endedAt = endedAt; record.summary.exitCodeHex = hex;
      record.summary.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(record.summary.startedAt));
      record.summary.status = 'collecting';
      if (record.summary.captureStatus === 'attached') record.summary.captureStatus = 'finished';
      if (result.exitCode === null) record.summary.warnings.push(result.signal ? 'Game ended by a signal; no native exception code was observed.' : 'The game exit code is unavailable; a crash is not established.');
      // A later export must never read shared logs from the next game. Capture
      // both a byte cutoff and a hash of the bounded evidence at the observed exit.
      const exitSnapshot = await this.sources(record.context);
      record.exitSources = [];
      record.issues.push(...exitSnapshot.issues);
      for (const source of exitSnapshot.files) {
        try {
          const tailStart = Math.max(0, source.size - FILE_LIMIT);
          const bytes = await boundedBytes(source.path, tailStart, source.size);
          const old = record.sources.find((item) => item.path === source.path)
            ?? record.sources.find((item) => item.root === source.root && item.ino !== 0 && item.ino === source.ino);
          const baselineOffset = old && source.ino === old.ino && source.size >= old.size
            && await prefixHash(source.path, old.size) === old.prefix ? old.size : null;
          const checked = await safeFile(source.path, source.root);
          if (checked.ino !== source.ino || checked.size !== source.size || checked.mtimeMs !== source.mtimeMs) throw new Error('source_changed_during_exit_boundary');
          record.exitSources.push({ ...source, tailStart, tailHash: createHash('sha256').update(bytes).digest('hex'), baselineOffset });
        } catch { record.issues.push({ source: source.label, reason: 'source_unavailable_at_exit_boundary' }); }
      }
      record.exitSourcesCapturedAt = new Date().toISOString();
      this.active.delete(id);
      await this.persist(record);
    });
  }
  private async dumps(id: string): Promise<{ path: string; size: number; name: string; full: boolean }[]> {
    const dir = this.getDirectory(id), files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9_.-]+\.dmp$/i.test(entry.name)) continue;
      try { const info = await safeFile(join(dir, entry.name), dir); files.push({ path: join(dir, entry.name), size: info.size, name: entry.name, full: /full/i.test(entry.name) }); }
      catch { /* In-progress, missing or linked dumps do not invalidate text evidence. */ }
    }
    return files;
  }
  async getReport(id: string): Promise<DiagnosticReportRecord> {
    await this.initialize(); await this.queues.get(id)?.catch(() => undefined);
    const record = this.require(id), dumps = await this.dumps(id);
    record.summary.dumpCount = dumps.length; record.summary.hasFullDump = dumps.some((dump) => dump.full);
    return structuredClone(record);
  }
  async listReports(): Promise<DiagnosticReportSummary[]> {
    await this.initialize();
    return Promise.all([...this.records.keys()].map(async (id) => (await this.getReport(id)).summary)).then((items) => items.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }
  async collectSession(id: string): Promise<DiagnosticReportSummary> {
    await this.initialize();
    const summary = await this.serial(id, async () => {
      const record = this.require(id), dir = this.getDirectory(id), collected = join(dir, 'collected');
      await mkdir(collected, { recursive: true });
      if ((await lstat(collected)).isSymbolicLink()) throw new Error('Unsafe collected directory.');
      if (record.summary.endedAt && record.collectionCompletedAt) {
        // Windows event metadata may be refreshed at export; frozen evidence
        // remains intact and is never replaced by current shared game logs.
        await this.writePublicFiles(record, collected);
        return structuredClone(record.summary);
      }
      const ended = Boolean(record.summary.endedAt);
      const current = ended
        ? { files: record.exitSources ?? [], issues: record.exitSourcesCapturedAt ? [] : [{ source: 'client-logs', reason: 'session_end_log_boundary_unavailable' }] }
        : await this.sources(record.context);
      const issues = [...record.issues.filter((issue) => !(issue.reason === 'ENOENT' && current.files.some((file) => file.label === issue.source || file.label.startsWith(`${issue.source}-`)))), ...current.issues];
      for (const old of record.sources) if (!current.files.some((item) => item.path === old.path)) issues.push({ source: old.label, reason: 'previous_source_missing_or_rotated' });
      let total = 0, count = 0;
      const saved = new Map<string, number>();
      // Preserve a valid earlier in-session capture when its shared source was
      // rotated, removed or changed after the exit. Only explicit prior outputs
      // are eligible; unknown leftovers never enter the archive.
      for (const name of Array.isArray(record.context.collectedFiles) ? record.context.collectedFiles : []) {
        if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name) || !/client-(?:local|failure|native|game)/.test(name)) continue;
        try {
          const info = await safeFile(join(collected, name), collected);
          if (info.size > FILE_LIMIT || count >= FILE_COUNT - 3 || total + info.size > TOTAL_LIMIT - 3 * FILE_LIMIT) continue;
          saved.set(name, info.size); total += info.size; count++;
        } catch { issues.push({ source: name, reason: 'previous_capture_unavailable' }); }
      }
      const save = async (name: string, text: string): Promise<void> => {
        // Native game log rows contain a machine-name column before their
        // session/event counters. Preserve clocks and game identities only.
        text = text.replace(/^(\d{4}-\d{2}-\d{2}\t\d{2}:\d{2}:\d{2}(?:\.\d+)?\t)[^\t\r\n]+(?=\t)/gm, '$1[HOST]');
        let sanitized: string;
        try {
          // Real client reports can be pretty-printed JSON, including nested
          // environment/credential records. Sanitize the full structure first.
          if (/\.jsonl(?:\.1)?$/.test(name)) throw new Error('line_delimited_json');
          sanitized = JSON.stringify(sanitizeDiagnosticValue(JSON.parse(text), this.secrets()), null, 2);
        } catch {
          if (/\.json$/.test(name)) {
            issues.push({ source: name, reason: 'incomplete_structured_log_omitted' });
            return;
          }
          sanitized = text.split(/\r?\n/).map((line) => {
            try { return JSON.stringify(sanitizeDiagnosticValue(JSON.parse(line), this.secrets())); } catch { return line; }
          }).join('\n');
        }
        const cleaned = redactDiagnosticText(sanitized, this.secrets());
        let bytes = Buffer.from(cleaned);
        if (bytes.length > FILE_LIMIT) { bytes = bytes.subarray(0, FILE_LIMIT); issues.push({ source: name, reason: 'sanitized_text_truncated_2MiB' }); }
        const previous = saved.get(name) ?? 0;
        if ((!saved.has(name) && count >= FILE_COUNT) || total - previous + bytes.length > TOTAL_LIMIT) { issues.push({ source: name, reason: 'total_collection_limit' }); return; }
        const path = join(collected, name);
        const existing = await lstat(path).catch(() => null);
        if (existing?.isSymbolicLink()) { issues.push({ source: name, reason: 'linked_output_skipped' }); return; }
        await writeFile(path, bytes); if (!saved.has(name)) count++; saved.set(name, bytes.length); total += bytes.length - previous;
      };
      // A tail cut inside the file starts in the middle of a row. Drop that partial
      // row: it is incomplete anyway, and save() only finds the PC-name column on
      // rows that begin with their date.
      const fromNextRow = (bytes: Buffer, cut: boolean): string => {
        if (!cut) return bytes.toString('utf8');
        const next = bytes.indexOf(0x0a);
        return bytes.subarray(next < 0 ? bytes.length : next + 1).toString('utf8');
      };
      const readTail = async (path: string, root: string, offset: number, label: string, cutoff?: ExitSourceSnapshot): Promise<string | null> => {
        try {
          const info = await safeFile(path, root);
          const end = cutoff?.size ?? info.size;
          const from = Math.max(offset, end - FILE_LIMIT);
          if (cutoff) {
            if (info.ino !== cutoff.ino || info.size < end) throw new Error('source_changed_since_exit_boundary');
            const bytes = await boundedBytes(path, cutoff.tailStart, end);
            if (createHash('sha256').update(bytes).digest('hex') !== cutoff.tailHash) throw new Error('source_changed_since_exit_boundary');
            if (end <= offset) return null;
            if (from > offset) issues.push({ source: label, reason: 'tail_truncated_2MiB' });
            // Return the already verified bytes, avoiding a second read race.
            return fromNextRow(bytes.subarray(from - cutoff.tailStart), from > offset);
          }
          if (end <= offset) return null;
          if (from > offset) issues.push({ source: label, reason: 'tail_truncated_2MiB' });
          return fromNextRow(await boundedBytes(path, from, end), from > offset);
        } catch (error) { issues.push({ source: label, reason: cutoff ? 'source_changed_or_unavailable_since_exit_boundary' : failureReason(error) }); return null; }
      };
      const startedMs = Date.parse(record.summary.startedAt);
      for (const source of current.files) {
        const label = `${source.label}-${createHash('sha256').update(source.path).digest('hex').slice(0, 12)}${extname(source.path).toLowerCase() || '.log'}`;
        if (!saved.has(label) && (count >= FILE_COUNT - 3 || total >= TOTAL_LIMIT - 3 * FILE_LIMIT)) { issues.push({ source: source.label, reason: 'client_log_budget_reserved_for_native_evidence' }); continue; }
        const old = record.sources.find((item) => item.path === source.path)
          ?? record.sources.find((item) => item.root === source.root && item.ino !== 0 && item.ino === source.ino);
        let offset = 0;
        if (old) {
          const fixedOffset = ended ? (source as ExitSourceSnapshot).baselineOffset : undefined;
          if (ended && typeof fixedOffset === 'number') offset = fixedOffset;
          else if (!ended && source.ino === old.ino && source.size >= old.size && await prefixHash(source.path, old.size).catch(() => '') === old.prefix) offset = old.size;
          else issues.push({ source: source.label, reason: 'log_rotated_or_rewritten_since_launch' });
        } else if (source.mtimeMs < startedMs || record.sources.some((item) => item.root === source.root && item.size === source.size && item.prefix === source.prefix)) { issues.push({ source: source.label, reason: 'pre_session_log_omitted' }); continue; }
        const text = await readTail(source.path, source.root, offset, label, ended ? source as ExitSourceSnapshot : undefined);
        if (text !== null) await save(label, text);
      }
      for (const name of ['events.jsonl', 'native-events.jsonl.1', 'native-events.jsonl']) {
        const path = join(dir, name);
        if (!(await lstat(path).catch(() => null))) continue;
        const text = await readTail(path, dir, 0, name);
        if (text !== null) {
          await save(name, text);
          if (name.startsWith('native-')) {
            for (const line of text.split(/\r?\n/)) {
              try {
                const event = JSON.parse(line) as Record<string, unknown>;
                if (/exception/i.test(String(event.event ?? event.type ?? '')) && (event.firstChance === false || event.secondChance === true || event.first_chance === false)) {
                  record.summary.kind = 'crash';
                }
              } catch { /* Partial final lines are preserved in the raw sanitized text. */ }
            }
          }
        }
      }
      const debugSaved = await this.collectDebugArtifacts(record, collected, issues);
      for (const [name, bytes] of debugSaved) { saved.set(name, bytes); total += bytes; }
      const dumps = await this.dumps(id);
      record.summary.dumpCount = dumps.length; record.summary.hasFullDump = dumps.some((dump) => dump.full);
      record.summary.totalBytes = total + dumps.reduce((sum, dump) => sum + dump.size, 0);
      record.issues = [...new Map(issues.map((issue) => [`${issue.source}:${issue.reason}`, issue])).values()].slice(-200);
      if (!this.active.has(id)) record.summary.status = record.issues.length ? 'partial' : 'ready';
      // Explicit file list prevents old collected leftovers from crossing into an export.
      record.context.collectedFiles = [...saved.keys()];
      if (ended) record.collectionCompletedAt = new Date().toISOString();
      await this.persist(record);
      await this.writePublicFiles(record, collected);
      this.changed();
      return structuredClone(record.summary);
    });
    await this.retention(id);
    return summary;
  }
  private async writePublicFiles(record: DiagnosticReportRecord, collected: string): Promise<void> {
    await atomicJson(join(collected, 'report.json'), this.publicRecord(record));
    const readme = join(collected, 'README.txt');
    if ((await lstat(readme).catch(() => null))?.isSymbolicLink()) throw new Error('Unsafe diagnostic readme.');
    await writeFile(readme, this.readme(record), 'utf8');
  }
  /** Session-owned debug evidence has a separate budget and is frozen by collectSession at completion. */
  private async collectDebugArtifacts(record: DiagnosticReportRecord, collected: string, issues: Issue[]): Promise<Map<string, number>> {
    const dir = this.getDirectory(record.summary.id), saved = new Map<string, number>();
    const secrets = this.secrets();
    let total = 0;
    // Preserve an earlier valid capture if a source is temporarily unavailable.
    for (const name of Array.isArray(record.context.collectedFiles) ? record.context.collectedFiles : []) {
      if (typeof name !== 'string' || !DEBUG_FILES.has(name)) continue;
      try {
        const info = await safeFile(join(collected, name), collected);
        if (info.size <= DEBUG_FILES.get(name)! && total + info.size <= DEBUG_TOTAL_LIMIT) { saved.set(name, info.size); total += info.size; }
      } catch { issues.push({ source: name, reason: 'previous_debug_capture_unavailable' }); }
    }
    for (const [name, limit] of DEBUG_FILES) {
      const source = join(dir, name), destination = join(collected, name);
      const present = await lstat(source).catch(() => null);
      if (!present) continue;
      const temporary = join(collected, `.debug-${randomUUID()}.tmp`);
      let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
      let outputHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const info = await safeFile(source, dir);
        if ((await lstat(destination).catch(() => null))?.isSymbolicLink()) throw new Error('linked_output');
        const available = Math.min(limit, DEBUG_TOTAL_LIMIT - total + (saved.get(name) ?? 0));
        sourceHandle = await open(source, 'r');
        const opened = await sourceHandle.stat();
        if (opened.ino !== info.ino || opened.size < info.size) throw new Error('debug_source_changed');
        outputHandle = await open(temporary, 'wx');
        let bytes = 0;
        if (name.endsWith('.json')) {
          if (info.size > limit) { issues.push({ source: name, reason: 'debug_summary_exceeds_64KiB' }); continue; }
          const buffer = Buffer.alloc(info.size);
          let offset = 0;
          while (offset < buffer.length) {
            const read = await sourceHandle.read(buffer, offset, buffer.length - offset, offset);
            if (!read.bytesRead) throw new Error('debug_source_changed');
            offset += read.bytesRead;
          }
          const sanitized = Buffer.from(JSON.stringify(sanitizeDiagnosticValue(JSON.parse(buffer.toString('utf8')), secrets), null, 2) + '\n');
          if (sanitized.length > available) { issues.push({ source: name, reason: 'debug_sanitized_summary_limit' }); continue; }
          await outputHandle.writeFile(sanitized); bytes = sanitized.length;
        } else if (info.size > 0) {
          const input = sourceHandle.createReadStream({ start: 0, end: Math.min(info.size, limit) - 1, autoClose: false });
          const lines = createInterface({ input, crlfDelay: Infinity });
          let pending: Buffer[] = [], pendingBytes = 0;
          let malformed = false, oversized = false, outputLimited = false;
          const flush = async () => { if (pendingBytes) { await outputHandle!.writeFile(Buffer.concat(pending, pendingBytes)); pending = []; pendingBytes = 0; } };
          try {
            for await (const line of lines) {
              if (!line.trim()) continue;
              if (Buffer.byteLength(line) > DEBUG_LINE_LIMIT) { oversized = true; continue; }
              let sanitized: Buffer;
              try { sanitized = Buffer.from(JSON.stringify(sanitizeDiagnosticValue(JSON.parse(line), secrets)) + '\n'); }
              catch { malformed = true; continue; }
              if (bytes + sanitized.length > available) { outputLimited = true; break; }
              bytes += sanitized.length; pending.push(sanitized); pendingBytes += sanitized.length;
              if (pendingBytes >= 64 * 1024) await flush();
            }
            await flush();
          } finally { lines.close(); input.destroy(); }
          if (info.size > limit) issues.push({ source: name, reason: 'debug_source_truncated_16MiB' });
          if (oversized) issues.push({ source: name, reason: 'debug_rows_exceeding_64KiB_omitted' });
          if (malformed) issues.push({ source: name, reason: 'debug_incomplete_or_invalid_json_rows_omitted' });
          if (outputLimited) issues.push({ source: name, reason: 'debug_sanitized_output_limit' });
        }
        await outputHandle.close(); outputHandle = undefined;
        await rename(temporary, destination);
        total += bytes - (saved.get(name) ?? 0); saved.set(name, bytes);
      } catch (error) { issues.push({ source: name, reason: `debug_evidence_unavailable_${failureReason(error)}` }); }
      finally {
        await sourceHandle?.close().catch(() => undefined);
        await outputHandle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return saved;
  }
  private publicRecord(record: DiagnosticReportRecord): unknown {
    const { installationRoot: _root, logsRoot: _logs, ...context } = record.context;
    return sanitizeDiagnosticValue({ schemaVersion: 1, summary: record.summary, context, timezoneOffsetMinutes: record.timezoneOffsetMinutes, exit: record.exit, issues: record.issues,
      evidenceWindow: { sharedLogCutoffCapturedAt: record.exitSourcesCapturedAt ?? null, collectedAt: record.collectionCompletedAt ?? null } }, this.secrets());
  }
  private readme(record: DiagnosticReportRecord): string {
    return redactDiagnosticText([
      'ROTK diagnostic report', `Report: ${record.summary.id}`, `Started (UTC): ${record.summary.startedAt}`,
      `UTC offset at launch (minutes): ${record.timezoneOffsetMinutes}`, `Launcher: ${record.summary.launcherVersion}`,
      `Server: ${record.summary.serverLabel}`, `Player: ${record.summary.playerName ?? 'unavailable'}`,
      `Classification: ${record.summary.kind}`, `Exit: ${record.exit?.hex ?? 'unavailable'} ${record.exit?.name ?? ''}`,
      `Player-declared incident: ${record.context.playerReportedCrash === true ? 'yes' : 'no'}${record.context.playerReportedAt ? ` (${record.context.playerReportedAt})` : ''}`,
      'A transport stall or unavailable exit code does not establish a native crash.',
      'Debug sessions: performance.jsonl(.1) contains approximately one-second process/system resource samples; it is not a frame-time trace.',
      'frame-times.jsonl(.1) contains measured frame/presentation timings only when the optional collector succeeded. Check frame-times-summary.json and its coverage/status before interpreting missing data.',
      'performance-summary.json and frame-times-summary.json describe their respective collectors. A missing or unavailable frame collector does not mean the game ran smoothly.',
      'KillFeed/LongFrames/GFxWrap/asset-load logs can be compared by timestamps with debug evidence. Coincidence with a kill does not establish that the killfeed or custom assets caused a stutter.',
      'Client game logs may use local time; compare the launch UTC offset and any internal millisecond timestamp. Shared logs are bounded at exit; session-owned debug evidence is frozen after collectors finish.',
      'Debug JSONL: up to 16 MiB per file (including each rotation separately), summaries up to 64 KiB, separate total budget 66 MiB. Invalid/incomplete JSON rows are omitted and declared in manifest issues.',
      'Text logs are bounded and sanitized. Command lines, environment and credential files are excluded.',
      'Binary memory dumps cannot be sanitized and may contain credentials, private messages or other process memory.',
      'Automatic Debug session reports include available memory dumps. Developer exports may omit them; consult manifest.json.',
      'Reports stay local until the player shares the ZIP. Share memory dumps only with a trusted administrator.',
      'Read manifest.json for included files, SHA-256 hashes, limits, omissions and collection issues.', '',
    ].join('\n'), this.secrets());
  }
  async exportReport(id: string, destination: string, options: { includeDumps: boolean; description: string }): Promise<void> {
    if (options.description.length > 4000) throw new Error('Diagnostic description exceeds 4000 characters.');
    await this.collectSession(id);
    return this.serial(id, async () => {
      const record = this.require(id), dir = this.getDirectory(id), target = resolve(destination);
      const parent = resolve(target, '..');
      const physicalParent = await realpath(parent);
      if (inside(target, this.directory) || inside(join(physicalParent, basename(target)), await realpath(this.directory))) throw new Error('Cannot export over internal diagnostic files.');
      if (await lstat(target).then(() => true, () => false)) throw new Error('The export destination already exists.');
      const temporary = join(physicalParent, `.rotk-report-${randomUUID()}.zip.tmp`);
      const zip = new yazl.ZipFile();
      const zipStream = zip.outputStream as Readable;
      const output = createWriteStream(temporary, { flags: 'wx' });
      zip.on('error', (error: Error) => { zipStream.destroy(error); });
      const completed = pipeline(zipStream, output);
      // Observe failures immediately while waiting for a source stream.
      void completed.catch(() => undefined);
      const files: { name: string; bytes: number; sha256: string }[] = [];
      const issues = [...record.issues];
      try {
        const names = [...(Array.isArray(record.context.collectedFiles) ? record.context.collectedFiles as string[] : []), 'report.json', 'README.txt'];
        const sources = names.filter((name) => /^[A-Za-z0-9_.-]+$/.test(name)).map((name) => ({ path: join(dir, 'collected', name), name, dump: false }));
        const dumps = await this.dumps(id);
        if (options.includeDumps) sources.push(...dumps.map((dump) => ({ path: dump.path, name: `dumps/${dump.name}`, dump: true })));
        for (const source of sources) {
          let info: Stats;
          try { info = await safeFile(source.path, dir); }
          catch (error) { issues.push({ source: source.name, reason: failureReason(error) }); continue; }
          try {
            const hash = createHash('sha256'); let bytes = 0;
            const checksum = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
            const input = info.size === 0 ? Readable.from([]) : createReadStream(source.path, { start: 0, end: info.size - 1 });
            const copied = pipeline(input, checksum);
            void copied.catch(() => undefined);
            zip.addReadStream(checksum, source.name, { size: info.size, compress: !source.dump });
            await Promise.race([copied, completed.then(() => { throw new Error('Archive stream ended unexpectedly.'); })]);
            files.push({ name: source.name, bytes, sha256: hash.digest('hex') });
          } catch (error) {
            // Once a stream was registered, a read failure must abort the ZIP;
            // preflight omissions stay explicit instead of fabricating evidence.
            if (zipStream.destroyed) throw error;
            throw new Error(`Could not stream diagnostic file (${failureReason(error)}).`);
          }
        }
        const notes = Buffer.from(redactDiagnosticText(options.description, this.secrets()) + '\n');
        zip.addBuffer(notes, 'NOTES.txt');
        files.push({ name: 'NOTES.txt', bytes: notes.length, sha256: createHash('sha256').update(notes).digest('hex') });
        const manifest = { schemaVersion: 1, reportId: id, exportedAt: new Date().toISOString(), launcherVersion: record.summary.launcherVersion,
          files, issues, omissions: options.includeDumps ? [] : dumps.map((dump) => ({ source: `dumps/${dump.name}`, reason: 'binary_dump_not_selected' })),
          limits: { textBytesPerFile: FILE_LIMIT, textBytesTotal: TOTAL_LIMIT, textFileCount: FILE_COUNT,
            debugJsonlBytesPerFile: DEBUG_JSONL_LIMIT, debugSummaryBytesPerFile: DEBUG_SUMMARY_LIMIT,
            debugBytesTotal: DEBUG_TOTAL_LIMIT, debugFileCount: DEBUG_FILES.size, debugJsonlBytesPerRow: DEBUG_LINE_LIMIT },
          containsUnredactedProcessMemory: options.includeDumps && dumps.length > 0,
          manifestHashNote: 'The manifest lists every payload file; it cannot contain its own SHA-256.' };
        zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'manifest.json');
        zip.end(); await completed;
        if (await lstat(target).then(() => true, () => false)) throw new Error('The export destination was created during export.');
        // Publish the completed file atomically without a check/rename overwrite
        // race. Both names are in the same directory/filesystem; link fails with
        // EEXIST if another writer claimed the selected destination meanwhile.
        try { await link(temporary, target); }
        catch (error) {
          if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          // FAT/exFAT and some network shares have no hard links. An exclusive
          // copy retains the no-overwrite guarantee and keeps the complete ZIP
          // source available until the destination copy finishes.
          await copyFile(temporary, target, fsConstants.COPYFILE_EXCL);
        }
        await rm(temporary);
      } catch (error) {
        zipStream.destroy(); output.destroy(); await completed.catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined); throw error;
      }
    });
  }
  /** Frozen, bounded evidence for private upload. Never send private session.json or an archive. */
  async prepareUpload(id: string): Promise<PreparedUpload> {
    return this.serial(id, async () => {
      const record = this.require(id), dir = this.getDirectory(id), uploadDir = join(dir, 'upload');
      if (!record.summary.endedAt || !record.collectionCompletedAt) throw new Error('Session is not finalized');
      await mkdir(uploadDir, { recursive: true });
      if ((await lstat(uploadDir)).isSymbolicLink()) throw new Error('Unsafe upload directory');
      const manifestPath = join(uploadDir, 'manifest.json');
      if (await lstat(manifestPath).then(() => true, () => false)) {
        if ((await safeFile(manifestPath, dir)).size > 24576) throw new Error('Invalid upload manifest');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PreparedUpload['manifest'];
        if (manifest.localId !== id || !Array.isArray(manifest.files) || manifest.files.length > 64) throw new Error('Invalid upload manifest');
        const paths: string[] = [];
        for (let index = 0; index < manifest.files.length; index++) {
          const path = join(uploadDir, `${index}.data`), file = manifest.files[index];
          const info = await safeFile(path, dir);
          if (info.size !== file.bytes || info.size > 32 * 1024 ** 2) throw new Error('Upload evidence changed');
          const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
          if (hash.digest('hex') !== file.sha256) throw new Error('Upload evidence changed'); paths.push(path);
        }
        return { manifest, paths };
      }
      const manifest: PreparedUpload['manifest'] = { schemaVersion: 1, localId: id, launcherVersion: record.summary.launcherVersion,
        startedAt: record.summary.startedAt, endedAt: record.summary.endedAt, files: [] };
      const paths: string[] = [], omissions: { name: string; reason: string }[] = []; let total = 0;
      const names = [...new Set(['report.json', ...(Array.isArray(record.context.collectedFiles) ? record.context.collectedFiles as string[] : [])])];
      const sources = names.filter(name => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(name) && !name.includes('..'))
        .map(name => ({ name, path: join(dir, 'collected', name), kind: 'text' as 'text' | 'dump' }));
      sources.push(...(await this.dumps(id)).map(dump => ({ name: dump.name, path: dump.path, kind: 'dump' as const })));
      for (const source of sources) {
        try {
          if (!/\.(txt|log|json|jsonl|xml|dmp)(\.\d{1,3})?$/i.test(source.name) || source.name.length > 120 || source.name.includes('..')) throw new Error('name_excluded');
          const info = await safeFile(source.path, dir);
          const limit = (source.kind === 'dump' ? 32 : 16) * 1024 ** 2;
          if (info.size > limit || manifest.files.length >= 63 || total + info.size > 95 * 1024 ** 2) throw new Error('upload_size_limit');
          let data = await readFile(source.path);
          if (data.length > limit) throw new Error('source_grew');
          if (source.kind === 'text') data = Buffer.from(redactDiagnosticText(data.toString('utf8'), this.secrets()));
          if (data.length > limit || total + data.length > 95 * 1024 ** 2) throw new Error('upload_size_limit');
          const path = join(uploadDir, `${paths.length}.data`); await writeFile(path, data);
          paths.push(path); manifest.files.push({ name: source.name, kind: source.kind, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }); total += data.length;
        } catch { omissions.push({ name: source.name, reason: 'unavailable_or_upload_limit' }); }
      }
      const notes = Buffer.from(JSON.stringify({ schemaVersion: 1, omissions, untrustedClientEvidence: true,
        privacy: 'Text is redacted; binary dumps contain unredacted process memory and remain quarantined.',
        limits: { files: 64, textMiB: 16, dumpMiB: 32, reportMiB: 96 } }));
      const path = join(uploadDir, `${paths.length}.data`); await writeFile(path, notes); paths.push(path);
      manifest.files.push({ name: 'upload-coverage.json', kind: 'text', bytes: notes.length, sha256: createHash('sha256').update(notes).digest('hex') });
      await atomicJson(manifestPath, manifest); return { manifest, paths };
    });
  }
  private async retention(protectedId?: string): Promise<void> {
    const candidates = [...this.records.values()].filter((r) => !this.active.has(r.summary.id) && r.summary.status !== 'recording' && r.summary.status !== 'collecting').sort((a, b) => b.summary.startedAt.localeCompare(a.summary.startedAt));
    let bytes = 0;
    for (let index = 0; index < candidates.length; index++) {
      const record = candidates[index], dir = this.getDirectory(record.summary.id);
      let safe = true, size = 0;
      const inspect = async (path: string): Promise<void> => {
        if (!inside(path, this.directory)) { safe = false; return; }
        const info = await lstat(path);
        if (info.isSymbolicLink()) { safe = false; return; }
        if (info.isDirectory()) for (const child of await readdir(path)) await inspect(join(path, child));
        else size += info.size;
      };
      try { await inspect(dir); } catch { continue; }
      bytes += size;
      const expired = Date.now() - Date.parse(record.summary.startedAt) > 7 * 24 * 3600_000;
      if (index === 0 || !safe || record.summary.id === protectedId || this.queues.has(record.summary.id) || (index < 10 && !expired && bytes <= RETENTION_BYTES)) continue;
      if (!inside(await realpath(dir), await realpath(this.directory))) continue;
      await rm(dir, { recursive: true, force: true }).then(() => { this.records.delete(record.summary.id); bytes -= size; }).catch(() => undefined);
    }
  }
}
