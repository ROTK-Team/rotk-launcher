import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// The real build check needs the 82 MB H1Z1.exe and the Vivox step its DLLs;
// both have their own tests. Here only the copy/resume/repair flow matters.
// Here a 3-byte H1Z1.exe ("exe") is the supported build and anything else is not.
vi.mock("../electron/services/client-build.js", async (original) => {
  const actual = await original<typeof import("../electron/services/client-build.js")>();
  const build = { id: "test-build", fileVersion: "0", executableSize: 3, executableSha256: "" };
  return {
    ...actual,
    SUPPORTED_CLIENT_BUILDS: [build],
    findSupportedBuild: (size: number) => (size === 3 ? build : undefined),
  };
});
vi.mock("../electron/services/vivox-client.js", () => ({
  deployVivoxCompatibility: async () => undefined,
}));

const faults = vi.hoisted(() => ({ driveRoot: null as string | null }));
// Windows refuses mkdir on a drive root with EPERM, even with recursive. A test
// marks a folder as that root to install right under it, like G:\ROTK.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdir: (...args: Parameters<typeof fs.mkdir>) => String(args[0]) === faults.driveRoot
      ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(args[0])}'`), { code: "EPERM" }))
      : fs.mkdir(...args),
  };
});

const { findSupportedDepotExecutable, steamExecutableStatus, installClient, inspectDestination, readInstallationMarker } = await import("../electron/services/installer.js");
const { INSTALL_PENDING_MARKER_NAME } = await import("../electron/constants.js");

const roots: string[] = [];
afterEach(async () => {
  faults.driveRoot = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SOURCE_FILES: Record<string, string> = {
  "H1Z1.exe": "exe",
  "ClientConfig.ini": "[Config]\n",
  "steam_api64.dll": "vanilla steam",
  "UserOptions.ini": "[Display]\nMode=Steam\n",
  "Resources/Assets/assets_x64_0.pack2": "pack-0".repeat(1000),
  "Resources/Assets/assets_x64_1.pack2": "pack-1".repeat(1000),
  "Resources/Audio/pc9/Weapons.bnk_pc": "bank",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitest-install-flow-"));
  roots.push(root);
  const source = join(root, "source");
  for (const [path, contents] of Object.entries(SOURCE_FILES)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), contents);
  }
  const shim = join(root, "shim.dll");
  await writeFile(shim, "rotk shim");
  const destination = join(root, "Games", "ROTK");
  const request = (
    signal = new AbortController().signal,
    onProgress = (_: unknown) => undefined,
    steamDepot?: { folders: string[]; installedManifestId: string | null },
  ) => ({
    sourceRoot: source,
    destinationRoot: destination,
    shimPath: shim,
    vivoxProxyPath: "unused",
    vivoxRuntimePath: "unused",
    launcherVersion: "test",
      launcherFolder: null,
    steamDepot,
    signal,
    onProgress,
  });
  return { root, source, destination, request };
}

const read = (path: string) => readFile(path, "utf8");

describe("installClient flow", () => {
  it("copies, patches and marks a fresh install without touching the source", async () => {
    const { source, destination, request } = await fixture();
    const marker = await installClient(request());

    expect(await inspectDestination(destination)).toBe("installed");
    expect(await readInstallationMarker(destination)).toMatchObject({ installId: marker.installId });
    await expect(stat(join(destination, INSTALL_PENDING_MARKER_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await read(join(destination, "steam_api64.dll"))).toBe("rotk shim");
    expect(await read(join(destination, "steam_api64.original.dll"))).toBe("vanilla steam");
    expect(await read(join(destination, "Resources/Assets/assets_x64_1.pack2"))).toBe(SOURCE_FILES["Resources/Assets/assets_x64_1.pack2"]);
    expect(await read(join(source, "steam_api64.dll"))).toBe("vanilla steam");
  });

  it("installs into a folder right under a drive root, like G:\\ROTK", async () => {
    const { destination, request } = await fixture();
    await mkdir(dirname(destination));
    // The installer works on the physical path, and a temp folder can sit behind
    // an 8.3 short name (C:\Users\RUNNER~1 on CI) or a junction.
    faults.driveRoot = await realpath(dirname(destination));

    await installClient(request());
    expect(await inspectDestination(destination)).toBe("installed");
  });

  it("resumes after a cancel without starting over", async () => {
    const { destination, request } = await fixture();
    const cancel = new AbortController();
    await expect(installClient(request(cancel.signal, (progress) => {
      if ((progress as { filesCompleted: number }).filesCompleted >= 2) cancel.abort(new DOMException("cancelled", "AbortError"));
    }))).rejects.toMatchObject({ name: "AbortError" });
    expect(await inspectDestination(destination)).toBe("pending");

    let firstCopyProgress = -1;
    const marker = await installClient(request(undefined, (progress) => {
      const value = progress as { phase: string; filesCompleted: number };
      if (firstCopyProgress < 0 && value.phase === "copying") firstCopyProgress = value.filesCompleted;
    }));
    expect(firstCopyProgress).toBeGreaterThanOrEqual(2);
    expect(await readInstallationMarker(destination)).toMatchObject({ installId: marker.installId });
  });

  it("resumes a run that stopped after patching, keeping the vanilla backup", async () => {
    const { destination, request } = await fixture();
    const first = await installClient(request());
    // Simulate a crash between the patches and the final marker.
    await unlink(join(destination, ".rotk-installation.json"));
    await writeFile(join(destination, INSTALL_PENDING_MARKER_NAME), JSON.stringify({
      schemaVersion: 1, installId: first.installId, sourceRoot: "x", startedAt: "2026-09-29T00:00:00Z",
    }));

    const resumed = await installClient(request());
    expect(resumed.installId).toBe(first.installId);
    expect(await read(join(destination, "steam_api64.dll"))).toBe("rotk shim");
    expect(await read(join(destination, "steam_api64.original.dll"))).toBe("vanilla steam");
  });

  it("repairs a finished install: restores missing, truncated and damaged files, keeps player settings", async () => {
    const { destination, request } = await fixture();
    const first = await installClient(request());
    await unlink(join(destination, "Resources/Audio/pc9/Weapons.bnk_pc"));
    await writeFile(join(destination, "Resources/Assets/assets_x64_0.pack2"), "pack-0");
    await writeFile(join(destination, "H1Z1.exe"), "EXE"); // same size, other bytes
    await writeFile(join(destination, "UserOptions.ini"), "[Display]\nMode=Player\n");

    const repaired = await installClient(request());
    expect(repaired.installId).toBe(first.installId);
    expect(repaired.installedAt).toBe(first.installedAt);
    expect(await read(join(destination, "Resources/Audio/pc9/Weapons.bnk_pc"))).toBe("bank");
    expect(await read(join(destination, "Resources/Assets/assets_x64_0.pack2"))).toBe(SOURCE_FILES["Resources/Assets/assets_x64_0.pack2"]);
    expect(await read(join(destination, "H1Z1.exe"))).toBe("exe");
    expect(await read(join(destination, "UserOptions.ini"))).toBe("[Display]\nMode=Player\n");
    expect(await read(join(destination, "steam_api64.dll"))).toBe("rotk shim");
    await expect(stat(join(destination, INSTALL_PENDING_MARKER_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Steam's unsupported H1Z1.exe update", () => {
  // Steam's 2026-11-20 update only replaced H1Z1.exe with a build ROTK does not support.
  async function steamUpdated() {
    const setup = await fixture();
    await writeFile(join(setup.source, "H1Z1.exe"), "new-exe");
    const depot = join(setup.root, "Steam", "steamapps", "content", "app_433850", "depot_433851");
    return { ...setup, depot };
  }

  it("refuses with the delta download command when the supported exe was not downloaded", async () => {
    const { destination, depot, request } = await steamUpdated();
    const failure = installClient(request(undefined, undefined, { folders: [depot], installedManifestId: "9048628616520611413" }));
    await expect(failure).rejects.toMatchObject({
      name: "UnsupportedClientBuildError",
      command: "download_depot 433850 433851 1929288548044868931 9048628616520611413",
    });
    expect(await inspectDestination(destination)).not.toBe("installed");
  });

  it("installs the rest from Steam and H1Z1.exe from the depot download", async () => {
    const { root, source, destination, depot, request } = await steamUpdated();
    await mkdir(depot, { recursive: true });
    await writeFile(join(depot, "H1Z1.exe"), "exe");

    const marker = await installClient(request(undefined, undefined, { folders: [join(root, "missing"), depot], installedManifestId: null }));
    expect(await read(join(destination, "H1Z1.exe"))).toBe("exe");
    expect(await read(join(destination, "Resources/Assets/assets_x64_1.pack2"))).toBe(SOURCE_FILES["Resources/Assets/assets_x64_1.pack2"]);
    expect(marker.criticalHashes["H1Z1.exe"]).toBe(createHash("sha256").update("exe").digest("hex"));
    expect(await read(join(source, "H1Z1.exe"))).toBe("new-exe");
  });

  it("the launcher's download watch only accepts the supported exe", async () => {
    const { root } = await fixture();
    const depot = join(root, "depot");
    await mkdir(depot, { recursive: true });
    expect(await findSupportedDepotExecutable([join(root, "missing"), depot])).toBeNull();
    await writeFile(join(depot, "H1Z1.exe"), "new-exe");
    expect(await findSupportedDepotExecutable([depot])).toBeNull();
    await writeFile(join(depot, "H1Z1.exe"), "exe");
    expect(await findSupportedDepotExecutable([depot])).toMatchObject({ path: join(depot, "H1Z1.exe"), size: 3 });
  });

  it("tells the setup, before any copy, whether a patch step is needed and done", async () => {
    const { root, source } = await fixture();
    const depot = join(root, "depot");
    const steamDepot = { folders: [depot], installedManifestId: "9048628616520611413" };
    expect(await steamExecutableStatus(source, steamDepot)).toBeNull();
    await writeFile(join(source, "H1Z1.exe"), "new-exe");
    expect(await steamExecutableStatus(source, steamDepot)).toEqual({
      command: "download_depot 433850 433851 1929288548044868931 9048628616520611413",
      downloaded: false,
    });
    await mkdir(depot, { recursive: true });
    await writeFile(join(depot, "H1Z1.exe"), "exe");
    expect(await steamExecutableStatus(source, steamDepot)).toMatchObject({ downloaded: true });
  });

  it("a repair after Steam's update never copies Steam's exe over the supported one", async () => {
    const { root, source, destination, request } = await fixture();
    await installClient(request());
    await writeFile(join(source, "H1Z1.exe"), "new-exe");
    await expect(installClient(request())).rejects.toMatchObject({ name: "UnsupportedClientBuildError" });
    expect(await read(join(destination, "H1Z1.exe"))).toBe("exe");

    const depot = join(root, "depot");
    await mkdir(depot, { recursive: true });
    await writeFile(join(depot, "H1Z1.exe"), "exe");
    await unlink(join(destination, "Resources/Audio/pc9/Weapons.bnk_pc"));
    await installClient(request(undefined, undefined, { folders: [depot], installedManifestId: null }));
    expect(await read(join(destination, "H1Z1.exe"))).toBe("exe");
    expect(await read(join(destination, "Resources/Audio/pc9/Weapons.bnk_pc"))).toBe("bank");
  });
});
