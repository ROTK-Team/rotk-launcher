import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The real build check needs the 82 MB H1Z1.exe and the Vivox step its DLLs;
// both have their own tests. Here only the copy/resume/repair flow matters.
vi.mock("../electron/services/client-build.js", () => ({
  identifyClientBuild: () => ({ id: "test-build", fileVersion: "0", executableSize: 0, executableSha256: "" }),
}));
vi.mock("../electron/services/vivox-client.js", () => ({
  deployVivoxCompatibility: async () => undefined,
}));

const { installClient, inspectDestination, readInstallationMarker } = await import("../electron/services/installer.js");
const { INSTALL_PENDING_MARKER_NAME } = await import("../electron/constants.js");

const roots: string[] = [];
afterEach(async () => {
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
  const request = (signal = new AbortController().signal, onProgress = (_: unknown) => undefined) => ({
    sourceRoot: source,
    destinationRoot: destination,
    shimPath: shim,
    vivoxProxyPath: "unused",
    vivoxRuntimePath: "unused",
    launcherVersion: "test",
    signal,
    onProgress,
  });
  return { source, destination, request };
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

  it("repairs a finished install: restores missing files, keeps assets and player settings", async () => {
    const { destination, request } = await fixture();
    const first = await installClient(request());
    await unlink(join(destination, "Resources/Audio/pc9/Weapons.bnk_pc"));
    await writeFile(join(destination, "Resources/Assets/assets_x64_0.pack2"), "rotk asset");
    await writeFile(join(destination, "UserOptions.ini"), "[Display]\nMode=Player\n");

    const repaired = await installClient(request());
    expect(repaired.installId).toBe(first.installId);
    expect(repaired.installedAt).toBe(first.installedAt);
    expect(await read(join(destination, "Resources/Audio/pc9/Weapons.bnk_pc"))).toBe("bank");
    expect(await read(join(destination, "Resources/Assets/assets_x64_0.pack2"))).toBe("rotk asset");
    expect(await read(join(destination, "UserOptions.ini"))).toBe("[Display]\nMode=Player\n");
    expect(await read(join(destination, "steam_api64.dll"))).toBe("rotk shim");
    await expect(stat(join(destination, INSTALL_PENDING_MARKER_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
