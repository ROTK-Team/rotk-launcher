import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticController } from '../electron/services/diagnostic-controller.js';
import type { NativeObserverOptions } from '../electron/services/diagnostic-observer.js';

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
  frameStarts: vi.fn<() => Promise<void>>(),
  frameStops: vi.fn<() => Promise<void>>(),
}));
vi.mock('../electron/services/diagnostic-frame-times.js', () => ({
  DiagnosticFrameTimes: class {
    start = mocks.frameStarts;
    stop = mocks.frameStops;
  },
}));
vi.mock('../electron/services/diagnostic-system.js', () => ({ collectDiagnosticSystemInfo: mocks.collectSystem, collectGameWindowsEvents: mocks.windowsEvents }));
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const roots: string[] = [];
beforeEach(() => {
  mocks.observers.length = 0;
  mocks.collectSystem.mockReset().mockResolvedValue({ os: 'Windows fixture', memoryBytes: 8 * 1024 ** 3 });
  mocks.windowsEvents.mockReset().mockResolvedValue([]);
  mocks.frameStarts.mockReset().mockResolvedValue(undefined);
  mocks.frameStops.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(join(tmpdir(), 'rotk-controller-test-')))) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(enabled = true, debug = false) {
  const root = await mkdtemp(join(tmpdir(), 'rotk-controller-test-')); roots.push(root);
  const onChange = vi.fn();
  const onDebugReport = vi.fn();
  const collectClientContext = vi.fn(async () => ({ schemaVersion: 1, assets: { syncEnabled: false }, video: { settings: { MaximumFPS: '500' } } }));
  const controller = new DiagnosticController({ directory: join(root, 'reports'), helperPath: join(root, 'helper.exe'),
    frameTimesPath: join(root, 'presentmon.exe'), exportDirectory: join(root, 'downloads'), collectClientContext,
    knownSecrets: () => ['known-player-secret'], onChange, onDebugReport });
  await controller.initialize(enabled, debug);
  const context = { launcherVersion: '2.0.7', serverLabel: 'TEST ONLY', serverId: 'fixture' };
  return { root, controller, context, onChange, onDebugReport, collectClientContext };
}

describe('diagnostic controller and persisted session lifecycle', () => {
  it('Debug is opt-in: a normal session does not start frame capture or automatically export', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    await launch.hooks.onPreparing?.();
    launch.hooks.onSpawned(4242);
    await launch.hooks.onExit(0, null);
    expect(mocks.observers[0]?.options.debug).toBe(false);
    expect(mocks.frameStarts).not.toHaveBeenCalled();
    expect(f.collectClientContext).not.toHaveBeenCalled();
    expect(f.onDebugReport).not.toHaveBeenCalled();
    expect(f.controller.debugState()).toMatchObject({ enabled: false, status: 'idle' });
  });

  it('captures prepared configuration before launch and creates a real ZIP on normal Debug exit', async () => {
    const f = await fixture(true, true), launch = await f.controller.beginLaunch(f.context);
    expect(f.controller.debugState().status).toBe('recording');
    await launch.hooks.onPreparing?.();
    expect(f.collectClientContext).toHaveBeenCalledOnce();
    expect(mocks.frameStarts).not.toHaveBeenCalled();
    launch.hooks.onSpawned(4242);
    expect(mocks.observers[0]?.options.debug).toBe(true);
    expect(mocks.frameStarts).toHaveBeenCalledOnce();
    const exiting = launch.hooks.onExit(0, null);
    expect(f.controller.debugState().status).toBe('preparing');
    expect(f.controller.isBusy()).toBe(true);
    expect(() => f.controller.setDebugEnabled(false)).toThrow();
    await exiting;
    const report = await f.controller.reports.getReport(launch.id);
    expect(report.summary.kind).toBe('exit');
    expect(report.context.clientContext).toMatchObject({ assets: { syncEnabled: false } });
    expect(report.context.debugSessionEnabled).toBe(true);
    expect(mocks.frameStops).toHaveBeenCalledOnce();
    expect(f.controller.debugState()).toMatchObject({ enabled: true, status: 'ready', error: null });
    expect(f.onDebugReport).toHaveBeenCalledOnce();
    const path = f.onDebugReport.mock.calls[0]![0];
    expect(path).toMatch(/ROTK-session-.*\.zip$/);
    expect((await readFile(path)).subarray(0, 2).toString()).toBe('PK');
    expect(f.controller.isBusy()).toBe(false);
  });

  it('a missing frame collector does not prevent the automatic report after a native crash', async () => {
    const f = await fixture(false, true), launch = await f.controller.beginLaunch(f.context);
    mocks.frameStarts.mockRejectedValue(new Error('Access denied'));
    launch.hooks.onSpawned(4242);
    expect(mocks.observers[0]?.options.debug).toBe(true);
    await launch.hooks.onExit(-1073741819, null);
    expect((await f.controller.reports.getReport(launch.id)).summary).toMatchObject({ kind: 'crash', exitCodeHex: '0xC0000005' });
    expect(f.onDebugReport).toHaveBeenCalledOnce();
    expect(f.controller.debugState().status).toBe('ready');
  });

  it('exports a Debug launch failure even when no client process was started', async () => {
    const f = await fixture(true, true), launch = await f.controller.beginLaunch(f.context);
    await f.controller.launchFailed(launch.id, new Error('Launcher version rejected'));
    expect(mocks.frameStarts).not.toHaveBeenCalled();
    expect((await f.controller.reports.getReport(launch.id)).summary.kind).toBe('launch-error');
    expect(f.onDebugReport).toHaveBeenCalledOnce();
  });

  it('releases the session and preserves evidence when automatic ZIP creation fails', async () => {
    const f = await fixture(true, true), launch = await f.controller.beginLaunch(f.context);
    const exportSpy = vi.spyOn(f.controller.reports, 'exportReport').mockRejectedValueOnce(new Error('Disk full'));
    launch.hooks.onSpawned(4242);
    await launch.hooks.onExit(0, null);
    expect(f.controller.debugState().status).toBe('error');
    expect(f.controller.isBusy()).toBe(false);
    expect((await f.controller.state()).recordingId).toBeNull();
    expect(f.onDebugReport).not.toHaveBeenCalled();
    exportSpy.mockRestore();
    const retry = await f.controller.reportCrash(join(f.root, 'downloads'), f.context);
    expect((await readFile(retry.path)).subarray(0, 2).toString()).toBe('PK');
    f.controller.setDebugEnabled(false);
  });

  it('waits for an in-flight collector startup before exporting and never starts a late collector', async () => {
    const started = deferred<void>();
    const f = await fixture(true, true), launch = await f.controller.beginLaunch(f.context);
    mocks.frameStarts.mockReturnValue(started.promise);
    launch.hooks.onSpawned(4242);
    const exiting = launch.hooks.onExit(0, null);
    await vi.waitFor(() => expect(mocks.observers[0]?.stop).toHaveBeenCalledOnce());
    expect(f.onDebugReport).not.toHaveBeenCalled();
    started.resolve();
    await exiting;
    expect(mocks.frameStops).toHaveBeenCalledOnce();
    expect(f.onDebugReport).toHaveBeenCalledOnce();
  });

  it('recovers and exports the latest interrupted Debug session once on restart', async () => {
    const f = await fixture();
    const interrupted = await f.controller.reports.beginSession({ ...f.context, debugSessionEnabled: true });
    const reveal = vi.fn();
    const recovered = new DiagnosticController({ directory: join(f.root, 'reports'), helperPath: join(f.root, 'helper.exe'),
      exportDirectory: join(f.root, 'downloads'), knownSecrets: () => [], onChange: () => {}, onDebugReport: reveal });
    await recovered.initialize(true, false);
    expect(reveal).toHaveBeenCalledOnce();
    expect(recovered.debugState()).toMatchObject({ enabled: false, status: 'ready' });
    expect((await recovered.reports.getReport(interrupted.id)).summary.kind).toBe('interrupted');
    await recovered.initialize(true, false);
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('recovers a Debug crash when the launcher stopped after observing exit but before export', async () => {
    const f = await fixture();
    const crashed = await f.controller.reports.beginSession({ ...f.context, debugSessionEnabled: true });
    await f.controller.reports.finalizeSession(crashed.id, { exitCode: -1073741819 });
    const reveal = vi.fn();
    const recovered = new DiagnosticController({ directory: join(f.root, 'reports'), helperPath: join(f.root, 'helper.exe'),
      exportDirectory: join(f.root, 'downloads'), knownSecrets: () => [], onChange: () => {}, onDebugReport: reveal });
    await recovered.initialize(true, true);
    expect(reveal).toHaveBeenCalledOnce();
    expect((await recovered.reports.getReport(crashed.id)).summary).toMatchObject({ kind: 'crash', exitCodeHex: '0xC0000005' });
  }, 20_000); // A real recovery and export can exceed 5s on a busy Windows CI runner.

  it('preserves the Windows startup crash code when launch also reports a generic startup failure', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    const exited = launch.hooks.onExit(-1073741819, null);
    await f.controller.launchFailed(launch.id, new Error('H1Z1 closed during initialization'));
    await exited;
    const report = await f.controller.reports.getReport(launch.id);
    expect(report.summary).toMatchObject({ kind: 'crash', exitCodeHex: '0xC0000005' });
    expect(report.summary.captureStatus).not.toBe('pending');
    expect(report.exit?.code).toBe(-1073741819);
    expect(report.exit?.error).toBeNull();
    expect(mocks.observers[0]?.stop).toHaveBeenCalledOnce();
    expect((await f.controller.state()).recordingId).toBeNull();
  });

  it('keeps the onExit promise pending until asynchronous evidence collection is complete', async () => {
    const system = deferred<Record<string, unknown>>();
    mocks.collectSystem.mockReturnValue(system.promise);
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    let completed = false;
    const exited = launch.hooks.onExit(0, null).then(() => { completed = true; });
    await vi.waitFor(() => expect(mocks.observers[0]?.drain).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect((await f.controller.state()).recordingId).toBe(launch.id);
    expect((await f.controller.reports.getReport(launch.id)).summary.status).toBe('collecting');
    system.resolve({ os: 'Windows delayed evidence' });
    await exited;
    expect(completed).toBe(true);
    expect((await f.controller.reports.getReport(launch.id)).context.systemInfo).toEqual({ os: 'Windows delayed evidence' });
    expect((await f.controller.state()).recordingId).toBeNull();
  });

  it('disabled native capture still creates useful game exit evidence without an observer', async () => {
    const f = await fixture(false), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    launch.hooks.onOutput('stderr', 'Client failed sessionid=known-player-secret');
    await launch.hooks.onExit(-1073741571, null);
    expect(mocks.observers).toHaveLength(0);
    const report = await f.controller.reports.getReport(launch.id);
    expect(report.summary.exitCodeHex).toBe('0xC00000FD');
    const events = await readFile(join(f.controller.reports.getDirectory(launch.id), 'events.jsonl'), 'utf8');
    expect(events).toContain('game_stderr');
    expect(events).not.toContain('known-player-secret');
  });

  it('an unavailable native helper adds a warning but never prevents the game lifecycle', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    expect(() => launch.hooks.onSpawned(4242)).not.toThrow();
    mocks.observers[0]!.options.onEvent({ event: 'attach-failed', reason: 'helper-missing-or-invalid' });
    await vi.waitFor(async () => expect((await f.controller.reports.getReport(launch.id)).summary.captureStatus).toBe('unavailable'));
    await launch.hooks.onExit(0, null);
    const report = await f.controller.reports.getReport(launch.id);
    expect(report.summary.kind).toBe('exit');
    expect(report.summary.warnings.join(' ')).toMatch(/unavailable/);
    expect((await f.controller.state()).recordingId).toBeNull();
  });

  it('rejects overlapping manual capture/export and keeps busy until the snapshot completes', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    const observer = mocks.observers[0]!; observer.attached = true;
    const snapshot = deferred<void>(); observer.snapshot.mockReturnValue(snapshot.promise);
    const capture = f.controller.capture({ mode: 'full', description: 'freeze in Combat Training' }, f.context);
    await vi.waitFor(() => expect(observer.snapshot).toHaveBeenCalledWith('full'));
    expect((await f.controller.state()).busy).toBe(true);
    await expect(f.controller.capture({ mode: 'standard', description: '' }, f.context)).rejects.toThrow(/already running/);
    await expect(f.controller.exportReport(launch.id, join(f.root, 'busy.zip'), { includeDumps: true, description: '' })).rejects.toThrow(/already running/);
    expect(observer.stop).not.toHaveBeenCalled();
    snapshot.resolve();
    const report = await capture;
    expect(report.id).toBe(launch.id);
    expect((await f.controller.state()).busy).toBe(false);
    expect((await f.controller.reports.getReport(launch.id)).context.notes).toBe('freeze in Combat Training');
    await launch.hooks.onExit(0, null);
  });

  it('manual capture failures preserve logs and a clear warning instead of failing the game session', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    const observer = mocks.observers[0]!; observer.attached = true;
    observer.snapshot.mockRejectedValue(new Error('Disk full'));
    const captured = await f.controller.capture({ mode: 'standard', description: 'hung game' }, f.context);
    expect(captured.warnings.join(' ')).toMatch(/memory capture did not complete/);
    expect((await f.controller.state()).busy).toBe(false);
    await launch.hooks.onExit(0, null);
  });

  it('uses a standalone snapshot only for the known active game PID when attachment is unavailable', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    await f.controller.capture({ mode: 'standard', description: 'freeze' }, f.context);
    expect(mocks.observers).toHaveLength(2);
    expect(mocks.observers[1]?.options.pid).toBe(4242);
    expect(mocks.observers[1]?.captureOnce).toHaveBeenCalledWith('standard');
    expect(mocks.observers[1]?.stop).toHaveBeenCalledOnce();
    expect(mocks.observers[0]?.stop).not.toHaveBeenCalled();
    await launch.hooks.onExit(0, null);
  });

  it('export waits for in-flight finalization before packaging the preserved crash outcome', async () => {
    const windows = deferred<unknown[]>(); mocks.windowsEvents.mockReturnValue(windows.promise);
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    const exited = launch.hooks.onExit(-1073741819, null);
    await vi.waitFor(() => expect(mocks.windowsEvents).toHaveBeenCalledOnce());
    const exportSpy = vi.spyOn(f.controller.reports, 'exportReport').mockResolvedValue(undefined);
    const exporting = f.controller.exportReport(launch.id, join(f.root, 'crash.zip'), { includeDumps: false, description: 'startup' });
    await Promise.resolve();
    expect(exportSpy).not.toHaveBeenCalled();
    expect((await f.controller.state()).busy).toBe(true);
    windows.resolve([{ provider: 'Application Error', id: 1000 }]);
    await Promise.all([exited, exporting]);
    expect(exportSpy).toHaveBeenCalledOnce();
    expect((await f.controller.reports.getReport(launch.id)).summary.exitCodeHex).toBe('0xC0000005');
    expect((await f.controller.state()).busy).toBe(false);
  });

  it('a capture requested during finalization uses the finished session without starting a late debugger', async () => {
    const windows = deferred<unknown[]>(); mocks.windowsEvents.mockReturnValue(windows.promise);
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    const exited = launch.hooks.onExit(-1073741571, null);
    await vi.waitFor(() => expect(mocks.windowsEvents).toHaveBeenCalledOnce());
    const capture = f.controller.capture({ mode: 'full', description: 'startup overflow' }, f.context);
    await Promise.resolve();
    expect(mocks.observers[0]?.snapshot).not.toHaveBeenCalled();
    expect(mocks.observers).toHaveLength(1);
    windows.resolve([]);
    const [, captured] = await Promise.all([exited, capture]);
    expect(captured.id).toBe(launch.id);
    expect(captured.exitCodeHex).toBe('0xC00000FD');
    expect((await f.controller.state()).busy).toBe(false);
  });

  it('deduplicates concurrent exit/failure finalization and recovers after collection errors', async () => {
    const f = await fixture(), launch = await f.controller.beginLaunch(f.context);
    launch.hooks.onSpawned(4242);
    vi.spyOn(f.controller.reports, 'collectSession').mockRejectedValueOnce(new Error('Disk unavailable'));
    await Promise.all([launch.hooks.onExit(-1073741819, null), launch.hooks.onExit(0, null), f.controller.launchFailed(launch.id, new Error('startup'))]);
    const state = await f.controller.state();
    expect(state.recordingId).toBeNull();
    expect(state.error).toMatch(/incomplete/);
    expect(mocks.observers[0]?.stop).toHaveBeenCalledOnce();
    expect((await f.controller.reports.getReport(launch.id)).summary.exitCodeHex).toBe('0xC0000005');
    const next = await f.controller.beginLaunch(f.context);
    await next.hooks.onExit(0, null);
  });

  it('a report without a running game is explicitly manual and never tries native memory capture', async () => {
    const f = await fixture();
    const report = await f.controller.capture({ mode: 'full', description: 'crashed before launcher opened' }, f.context);
    expect(report.kind).toBe('manual');
    expect(report.dumpCount).toBe(0);
    expect(report.warnings.join(' ')).toMatch(/No game was running/);
    expect(mocks.observers).toHaveLength(0);
    expect((await f.controller.state()).busy).toBe(false);
  });
  it('does not strand the controller when initial session metadata cannot be persisted', async () => {
    const f = await fixture();
    vi.spyOn(f.controller.reports, 'updateSession').mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(f.controller.beginLaunch(f.context)).rejects.toThrow('Disk unavailable');
    expect((await f.controller.state()).recordingId).toBeNull();
    const next = await f.controller.beginLaunch(f.context);
    await next.hooks.onExit(0, null);
    expect((await f.controller.state()).recordingId).toBeNull();
  });
  it('records at exit what the voice proxy logged about loading rotkc.dll in this game process', async () => {
    const f = await fixture();
    const installationRoot = join(f.root, 'game');
    await mkdir(installationRoot);
    const launch = await f.controller.beginLaunch({ ...f.context, installationRoot });
    launch.hooks.onSpawned(4242);
    const at = new Date(Date.now() + 1_000).toISOString();
    await writeFile(join(installationRoot, 'rotk-vivox-v5-compat.log'),
      `2020-01-01T00:00:00.000Z pid=4242 tid=1 [rotk-vivoxproxy] rotkc: loaded\r\n${at} pid=4242 tid=9 [rotk-vivoxproxy] rotkc: load failed error=126\r\n`);
    await launch.hooks.onExit(0, null);
    const report = await f.controller.reports.getReport(launch.id);
    expect(report.context.rotkcModule).toEqual({ status: 'load-failed', error: 126, at });
  });
});
