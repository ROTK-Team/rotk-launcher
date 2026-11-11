import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameLauncher, type AttestationOutcome, type LaunchRequest } from "../electron/services/game-launcher.js";
import { measureInstallation } from "../electron/services/integrity-attestation.js";
import { localizeServiceError } from "../electron/i18n.js";
import { RUNTIME_CONFIGS } from "../electron/services/runtime-config.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  gatewayClose: vi.fn(async () => undefined),
  createLaunchTicket: vi.fn(),
  assertLaunchTicketFresh: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../electron/services/path-policy.js", () => ({ validateInstallDestination: async (root: string) => root }));
vi.mock("../electron/services/installer.js", () => ({ readInstallationMarker: async () => ({ schemaVersion: 1, installId: "fixture" }) }));
vi.mock("../electron/services/vivox-client.js", () => ({
  deployVivoxCompatibility: async () => undefined,
  assertVivoxCompatibility: async () => undefined,
}));
vi.mock("../electron/services/gameplay-patch.js", () => ({ assertGameplayPatchState: async () => undefined }));
vi.mock("../electron/services/visual-cpp-runtime.js", () => ({ assertVisualCppRuntime: async () => undefined }));
vi.mock("../electron/services/launch-ticket.js", () => ({
  assertLaunchTicketFresh: mocks.assertLaunchTicketFresh,
  createLaunchTicket: mocks.createLaunchTicket,
}));
vi.mock("../electron/services/session-gateway.js", () => ({
  startLocalSessionGateway: async () => ({ createSessionUrl: "http://127.0.0.1:45678/rest/auth/session/create", close: mocks.gatewayClose }),
}));

class GameChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  unref = vi.fn();
  kill = vi.fn();
}

const TICKET = { ticket: "test-only-ticket", displayName: "FixturePlayer", steamId: "76561190000000000" };
const workspaces: string[] = [];
const children: GameChild[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mocks.gatewayClose.mockClear();
  mocks.assertLaunchTicketFresh.mockReset();
  mocks.createLaunchTicket.mockReset().mockResolvedValue(TICKET);
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new GameChild();
    children.push(child);
    return child;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const child of children.splice(0)) { child.stdout.destroy(); child.stderr.destroy(); }
  for (const workspace of workspaces.splice(0)) {
    if (!resolve(workspace).startsWith(resolve(join(tmpdir(), "rotk-launch-recheck-")))) throw new Error("Unsafe test cleanup");
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "rotk-launch-recheck-"));
  workspaces.push(workspace);
  const root = join(workspace, "game");
  const bundle = join(workspace, "bundle");
  const userData = join(workspace, "userdata");
  for (const directory of [root, bundle, userData]) await mkdir(directory, { recursive: true });
  await writeFile(join(root, "H1Z1.exe"), "game executable");
  await writeFile(join(root, "steam_api64.original.dll"), "vanilla steam api");
  await writeFile(join(root, "ClientConfig.ini"), "[Client]\n");
  await writeFile(join(bundle, "steam_api64.dll"), "rotk steam shim");
  await writeFile(join(bundle, "rotkc.dll"), "client module");
  const measureAndAttest = async (): Promise<AttestationOutcome> => {
    const measurement = await measureInstallation({
      installationRoot: root,
      userDataDirectory: userData,
      expected: [],
      detectUnexpected: true,
    });
    return { status: "attested", block: {}, clientPatchMode: "clean", measuredCode: measurement.code };
  };
  const attest = vi.fn(measureAndAttest);
  const request: LaunchRequest = {
    config: { schemaVersion: 1, installation: { installId: "fixture", root, sourceRoot: root,
      clientBuildId: "fixture", installedAt: new Date().toISOString(), criticalHashes: {} } },
    identity: { playerKey: "test-only-player-key" } as LaunchRequest["identity"],
    runtime: RUNTIME_CONFIGS.test,
    locale: "en",
    logsRoot: join(workspace, "logs"),
    bundledShimPath: join(bundle, "steam_api64.dll"),
    bundledVivoxProxyPath: join(bundle, "unused-proxy.dll"),
    bundledVivoxRuntimePath: join(bundle, "unused-runtime.dll"),
    bundledGameplayPatchPath: join(bundle, "unused-dinput8.dll"),
    bundledRotkcPath: join(bundle, "rotkc.dll"),
    bundledFontsPath: join(bundle, "unused-fonts"),
    clientPatchModeFallback: "clean",
    attest,
    onExit: vi.fn(),
  };
  return { root, request, attest, measureAndAttest, launcher: new GameLauncher() };
}

async function launchToStable(launcher: GameLauncher, request: LaunchRequest): Promise<number> {
  const launched = launcher.launch(request);
  // Slow CI runners: same ceiling as the other launch tests.
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled(), { timeout: 15_000 });
  await vi.advanceTimersByTimeAsync(3_000);
  return launched;
}

describe("executable files are checked again right before H1Z1 starts", () => {
  it("starts H1Z1 when nothing executable changed, whatever the launcher wrote after the measurement", async () => {
    const f = await fixture();
    await expect(launchToStable(f.launcher, f.request)).resolves.toBe(4242);
    expect(f.attest).toHaveBeenCalledOnce();
  });

  it.each(["dxgi.dll", "Browser/Resources/x64/version.dll"])(
    "refuses to start H1Z1 when %s appears between the measurement and the spawn", async (path) => {
      const f = await fixture();
      mocks.createLaunchTicket.mockImplementationOnce(async () => {
        const absolute = join(f.root, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, "added after the measurement");
        return TICKET;
      });

      await expect(f.launcher.launch(f.request)).rejects.toThrow(
        `Le fichier ${path} a changé après la vérification des fichiers du jeu. `
        + "Relance le jeu ; si ça recommence, un autre programme modifie peut-être le dossier du jeu.",
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.gatewayClose).toHaveBeenCalled();
    },
  );

  it("refuses to start H1Z1 when the measured executable changed in that window", async () => {
    const f = await fixture();
    mocks.createLaunchTicket.mockImplementationOnce(async () => {
      await writeFile(join(f.root, "H1Z1.exe"), "game executablf");
      return TICKET;
    });

    await expect(f.launcher.launch(f.request)).rejects.toThrow("Le fichier H1Z1.exe a changé");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("checks against the new measurement after a ticket refresh", async () => {
    const f = await fixture();
    mocks.assertLaunchTicketFresh.mockImplementationOnce(() => { throw new Error("expired"); });
    // Added before the second measurement, which therefore covers it.
    f.attest.mockImplementationOnce(async () => {
      const outcome = await f.measureAndAttest();
      await writeFile(join(f.root, "dxgi.dll"), "measured by the refresh");
      return outcome;
    });

    await expect(launchToStable(f.launcher, f.request)).resolves.toBe(4242);
    expect(f.attest).toHaveBeenCalledTimes(2);
  });

  it("launches an attested outcome that carries no executable list", async () => {
    const f = await fixture();
    f.request.attest = vi.fn(async () => ({ status: "attested", block: {}, clientPatchMode: "clean" } as const));
    mocks.createLaunchTicket.mockImplementationOnce(async () => {
      await writeFile(join(f.root, "dxgi.dll"), "nothing to compare with");
      return TICKET;
    });

    await expect(launchToStable(f.launcher, f.request)).resolves.toBe(4242);
  });

  it("leaves a launch without a measurement as it was", async () => {
    const f = await fixture();
    f.request.attest = vi.fn(async () => ({ status: "not-applicable", clientPatchMode: "clean" } as const));
    mocks.createLaunchTicket.mockImplementationOnce(async () => {
      await writeFile(join(f.root, "dxgi.dll"), "nothing was measured");
      return TICKET;
    });

    await expect(launchToStable(f.launcher, f.request)).resolves.toBe(4242);
  });

  it("explains the refusal in English and Chinese", () => {
    const message = "Le fichier dxgi.dll a changé après la vérification des fichiers du jeu. "
      + "Relance le jeu ; si ça recommence, un autre programme modifie peut-être le dossier du jeu.";
    expect(localizeServiceError(message, "fr")).toBe(message);
    expect(localizeServiceError(message, "en")).toBe(
      "The file dxgi.dll changed after the game files were checked. Play again; if this happens again, another program may be changing the game folder.",
    );
    expect(localizeServiceError(message, "zh")).toBe(
      "游戏文件校验完成后，dxgi.dll 发生了变化。请重新启动游戏；如果再次出现，可能有其他程序正在修改游戏文件夹。",
    );
  });
});
