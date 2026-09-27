import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameLauncher, type GameLaunchDiagnostics, type LaunchRequest } from '../electron/services/game-launcher.js';
import { RUNTIME_CONFIGS } from '../electron/services/runtime-config.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), gatewayClose: vi.fn(async () => undefined), ticket: vi.fn(), fresh: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../electron/services/path-policy.js', () => ({ validateInstallDestination: async (root: string) => root }));
vi.mock('../electron/services/installer.js', () => ({ readInstallationMarker: async () => ({ schemaVersion: 1, installId: 'fixture' }) }));
vi.mock('../electron/services/vivox-client.js', () => ({ deployVivoxCompatibility: async () => undefined }));
vi.mock('../electron/services/gameplay-patch.js', () => ({
  assertGameplayPatchState: async () => undefined,
  applyGameplayPatchMode: async () => "up-to-date",
}));
vi.mock('../electron/services/client-config.js', () => ({ synchronizeClientConfig: (current: string) => current,
  validateLocalCreateSessionUrl: (url: string) => url }));
vi.mock('../electron/services/launch-ticket.js', () => ({ assertLaunchTicketFresh: mocks.fresh,
  createLaunchTicket: mocks.ticket }));
vi.mock('../electron/services/session-gateway.js', () => ({
  startLocalSessionGateway: async () => ({ createSessionUrl: 'http://127.0.0.1:45678/createsession', close: mocks.gatewayClose }),
}));

class GameChild extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  unref = vi.fn();
  kill = vi.fn();
  exit(code: number): void { this.exitCode = code; this.emit('exit', code, null); }
}
const roots: string[] = [];
const children: GameChild[] = [];
beforeEach(() => {
  mocks.gatewayClose.mockClear();
  mocks.fresh.mockReset();
  mocks.ticket.mockReset().mockResolvedValue({ ticket: 'test-only-ticket', displayName: 'FixturePlayer', steamId: '76561190000000000' });
  mocks.spawn.mockReset().mockImplementation(() => { const child = new GameChild(); children.push(child); return child; });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const child of children.splice(0)) { child.stdout.destroy(); child.stderr.destroy(); }
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(join(tmpdir(), 'rotk-game-lifecycle-test-')))) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rotk-game-lifecycle-test-')); roots.push(root);
  for (const name of ['H1Z1.exe', 'steam_api64.original.dll', 'bundled-shim.dll']) await writeFile(join(root, name), 'fixture bytes');
  await writeFile(join(root, 'ClientConfig.ini'), '[Client]\n');
  const diagnostics: GameLaunchDiagnostics = { onIdentity: vi.fn(), onSpawned: vi.fn(), onOutput: vi.fn(), onExit: vi.fn(async () => undefined) };
  const request: LaunchRequest = {
    config: { schemaVersion: 1, installation: { installId: 'fixture', root, sourceRoot: root,
      clientBuildId: 'fixture', installedAt: new Date().toISOString(), criticalHashes: {} } },
    identity: { playerKey: 'test-only-player-key' } as LaunchRequest['identity'],
    runtime: RUNTIME_CONFIGS.test, logsRoot: join(root, 'logs'), bundledShimPath: join(root, 'bundled-shim.dll'),
    bundledVivoxProxyPath: join(root, 'unused-proxy.dll'), bundledVivoxRuntimePath: join(root, 'unused-runtime.dll'),
    bundledGameplayPatchPath: join(root, 'unused-dinput8.dll'),
    attest: vi.fn(async () => ({ status: 'attested', block: { challengeId: 'fixture' },
      hwid: { machine_guid: 'fixture-machine' }, clientPatchMode: 'clean' } as const)),
    diagnostics, onExit: vi.fn(),
  };
  return { launcher: new GameLauncher(), request, diagnostics, child: () => children.at(-1)! };
}

describe('game lifecycle remains independent of diagnostics', () => {
  it('awaits prepared session evidence before creating the game process', async () => {
    const f = await fixture(), prepared = deferred();
    const clientRoot = f.request.config.installation!.root;
    const defaultProfile = '<Profile name="Default"><ActionSet name="Generic"><Action name="OpenMap" ignoreModifiers="false"><Trigger>M</Trigger></Action><Action name="ToggleInventory" ignoreModifiers="false"><Trigger>Tab</Trigger></Action></ActionSet></Profile>';
    await writeFile(join(clientRoot, 'InputProfile_Default.xml'), defaultProfile);
    f.diagnostics.onPreparing = vi.fn(() => prepared.promise);
    const launched = f.launcher.launch(f.request).catch(error => error);
    await vi.waitFor(() => expect(f.diagnostics.onPreparing).toHaveBeenCalledOnce());
    expect(mocks.spawn).not.toHaveBeenCalled();
    const userProfile = await readFile(join(clientRoot, 'InputProfile_User.xml'), 'utf8');
    expect(userProfile).toContain('<Trigger>Shift+M</Trigger>');
    expect(userProfile).toContain('<Trigger>Shift+Tab</Trigger>');
    expect(await readFile(join(clientRoot, 'InputProfile_Default.xml'), 'utf8')).toBe(defaultProfile);
    prepared.resolve();
    await vi.waitFor(() => expect(f.diagnostics.onSpawned).toHaveBeenCalledWith(4242));
    f.child().exit(0);
    await launched;
    expect(f.diagnostics.onPreparing).toHaveBeenCalledOnce();
  });

  it('reports a real startup exit code and waits for collection before invoking the launcher exit callback', async () => {
    const f = await fixture(), collection = deferred();
    vi.mocked(f.diagnostics.onExit).mockReturnValue(collection.promise);
    const launched = f.launcher.launch(f.request).catch(error => error);
    await vi.waitFor(() => expect(f.diagnostics.onSpawned).toHaveBeenCalledWith(4242));
    f.child().exit(-1073741819);
    expect((await launched).message).toContain('0xC0000005');
    expect(f.diagnostics.onExit).toHaveBeenCalledWith(-1073741819, null);
    expect(f.launcher.isRunning()).toBe(false);
    expect(f.request.onExit).not.toHaveBeenCalled();
    expect(mocks.gatewayClose).toHaveBeenCalled();
    collection.resolve();
    await vi.waitFor(() => expect(f.request.onExit).toHaveBeenCalledWith(-1073741819));
    expect(f.child().kill).not.toHaveBeenCalled();
  });

  it('throwing diagnostic callbacks cannot prevent launch, output processing or final game cleanup', async () => {
    const f = await fixture();
    f.diagnostics.onPreparing = vi.fn(async () => { throw new Error('Diagnostic disk unavailable'); });
    for (const hook of ['onIdentity', 'onSpawned', 'onOutput', 'onExit'] as const)
      vi.mocked(f.diagnostics[hook]).mockImplementation(() => { throw new Error('Diagnostic callback failed'); });
    const launched = f.launcher.launch(f.request);
    await vi.waitFor(() => expect(f.diagnostics.onSpawned).toHaveBeenCalledWith(4242));
    expect(() => f.child().stdout.write('game message')).not.toThrow();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(launched).resolves.toBe(4242);
    expect(f.launcher.isRunning()).toBe(true);
    expect(() => f.child().exit(0)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request.onExit).toHaveBeenCalledOnce();
    expect(f.launcher.isRunning()).toBe(false);
    expect(f.child().kill).not.toHaveBeenCalled();
  });

  it('a rejected asynchronous collector still delivers onExit exactly once', async () => {
    const f = await fixture();
    vi.mocked(f.diagnostics.onExit).mockRejectedValue(new Error('Collection disk failure'));
    const launched = f.launcher.launch(f.request).catch(error => error);
    await vi.waitFor(() => expect(f.diagnostics.onSpawned).toHaveBeenCalled());
    f.child().exit(-1073741571);
    f.child().emit('error', new Error('late process error'));
    expect((await launched).message).toContain('0xC00000FD');
    await vi.waitFor(() => expect(f.request.onExit).toHaveBeenCalledWith(-1073741571));
    expect(f.request.onExit).toHaveBeenCalledOnce();
    expect(f.diagnostics.onExit).toHaveBeenCalledOnce();
    expect(f.child().kill).not.toHaveBeenCalled();
  });

  it('spawn failures with no PID have an error listener before the process emits its failure', async () => {
    const f = await fixture();
    mocks.spawn.mockImplementation(() => { const child = new GameChild(); child.pid = undefined; children.push(child); return child; });
    await expect(f.launcher.launch(f.request)).rejects.toThrow(/identifiant|Windows/);
    expect(f.diagnostics.onSpawned).not.toHaveBeenCalled();
    expect(() => f.child().emit('error', new Error('ENOENT'))).not.toThrow();
    expect(f.child().kill).not.toHaveBeenCalled();
    expect(mocks.gatewayClose).toHaveBeenCalled();
  });
});


describe('launch verification gate', () => {
  it.each(['unavailable', 'not-applicable'] as const)('refuses %s attestation before requesting a ticket', async status => {
    const f = await fixture();
    f.request.attest = async () => ({ status, reason: 'verification service unavailable', clientPatchMode: 'clean' });
    await expect(f.launcher.launch(f.request)).rejects.toThrow('could not complete integrity verification');
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], '', 'invalid'])('refuses malformed attestation blocks (case %#)', async block => {
    const f = await fixture();
    f.request.attest = async () => ({ status: 'attested', block, hwid: { machine_guid: 'fixture' }, clientPatchMode: 'clean' });
    await expect(f.launcher.launch(f.request)).rejects.toThrow('could not complete integrity verification');
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('does not turn a collector failure into a ticket request', async () => {
    const f = await fixture();
    f.request.attest = async () => { throw new Error('Hardware verification timed out'); };
    await expect(f.launcher.launch(f.request)).rejects.toThrow('Hardware verification timed out');
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects empty attested evidence without consulting a fallback', async () => {
    const f = await fixture();
    f.request.attest = async () => ({ status: 'attested', block: {}, hwid: {}, clientPatchMode: 'clean' });
    await expect(f.launcher.launch(f.request)).rejects.toMatchObject({ code: 'hwid_verification_failed' });
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rechecks evidence on ticket refresh and closes the previous gateway on failure', async () => {
    const f = await fixture();
    const first = await f.request.attest();
    f.request.attest = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({
      status: 'attested', block: { challengeId: 'second' }, hwid: {}, clientPatchMode: 'clean',
    });
    mocks.fresh.mockImplementationOnce(() => { throw new Error('expired'); });
    await expect(f.launcher.launch(f.request)).rejects.toMatchObject({ code: 'hwid_verification_failed' });
    expect(f.request.attest).toHaveBeenCalledTimes(2);
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayClose).toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('uses the new signed vector when refreshing, never the first vector', async () => {
    const f = await fixture();
    const first = await f.request.attest();
    f.request.attest = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({
      status: 'attested', block: { challengeId: 'second' }, hwid: { machine_guid: 'second' }, clientPatchMode: 'clean',
    });
    mocks.fresh.mockImplementationOnce(() => { throw new Error('expired'); });
    const launched = f.launcher.launch(f.request).catch(error => error);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(mocks.ticket).toHaveBeenNthCalledWith(2, f.request.identity.playerKey, f.request.runtime.launchTicketUrl, {
      attestation: { challengeId: 'second' }, hwid: { machine_guid: 'second' },
    });
    f.child().exit(0);
    await launched;
  });

  it('rejects concurrent launches and releases the lock after a verification failure', async () => {
    const f = await fixture(), gate = deferred();
    f.request.attest = vi.fn(async () => { await gate.promise; throw new Error('verification failed'); });
    const first = f.launcher.launch(f.request).catch(error => error);
    await vi.waitFor(() => expect(f.request.attest).toHaveBeenCalledOnce());
    await expect(f.launcher.launch(f.request)).rejects.toThrow('déjà lancé');
    gate.resolve();
    expect((await first).message).toBe('verification failed');
    await expect(f.launcher.launch(f.request)).rejects.toThrow('verification failed');
    expect(f.request.attest).toHaveBeenCalledTimes(2);
    expect(mocks.ticket).not.toHaveBeenCalled();
  });
});
