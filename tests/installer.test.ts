import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectDestination,
  installClient,
  installerInternals,
  readInstallationMarker,
} from "../electron/services/installer.js";
import { INSTALL_MARKER_NAME, INSTALL_PENDING_MARKER_NAME } from "../electron/constants.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitest-installer-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installer destination handling", () => {
  it("classifies destination folders", async () => {
    const root = await temporaryRoot();
    expect(await inspectDestination(join(root, "missing"))).toBe("absent");

    const empty = join(root, "empty");
    await mkdir(empty);
    expect(await inspectDestination(empty)).toBe("empty");

    const foreign = join(root, "foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, "notes.txt"), "mine");
    expect(await inspectDestination(foreign)).toBe("foreign");

    const pending = join(root, "pending");
    await mkdir(pending);
    await writeFile(join(pending, INSTALL_PENDING_MARKER_NAME), JSON.stringify({
      schemaVersion: 1, installId: "a", sourceRoot: "C:\\src", startedAt: "2026-09-29T00:00:00Z",
    }));
    expect(await inspectDestination(pending)).toBe("pending");
  });

  it("refuses a folder holding someone else's files", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    await mkdir(source);
    for (const name of ["H1Z1.exe", "ClientConfig.ini", "steam_api64.dll"]) {
      await writeFile(join(source, name), name);
    }
    const destination = join(root, "Games", "ROTK");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "notes.txt"), "mine");

    await expect(installClient({
      sourceRoot: source,
      destinationRoot: destination,
      shimPath: "unused",
      vivoxProxyPath: "unused",
      vivoxRuntimePath: "unused",
      launcherVersion: "test",
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).rejects.toThrow(/contient déjà d’autres fichiers/);
    await expect(readFile(join(destination, "notes.txt"), "utf8")).resolves.toBe("mine");
  });

  it("removes staging folders left by older launchers, and nothing else", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "ROTK");
    await mkdir(join(root, ".rotk-staging-1234", "Resources"), { recursive: true });
    await mkdir(join(root, "Other"));

    await installerInternals.removeLegacyStagingDirectories(destination);
    expect((await readdir(root)).sort()).toEqual(["Other"]);
  });

  it("skips files an earlier run finished and keeps player settings", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "pack.pack2");
    const targetPath = join(root, "copy.pack2");
    await writeFile(sourcePath, "0123456789");
    const modifiedAt = new Date("2026-01-01T10:00:00Z");
    await utimes(sourcePath, modifiedAt, modifiedAt);
    const source = { relativePath: "Resources\\pack.pack2", absolutePath: sourcePath, size: 10, modifiedAt };

    expect(await installerInternals.needsCopy(source, targetPath)).toBe(true);
    await writeFile(targetPath, "0123456789");
    await utimes(targetPath, modifiedAt, modifiedAt);
    expect(await installerInternals.needsCopy(source, targetPath)).toBe(false);
    await writeFile(targetPath, "01234");
    expect(await installerInternals.needsCopy(source, targetPath)).toBe(true);

    const options = { ...source, relativePath: "UserOptions.ini" };
    expect(await installerInternals.needsCopy(options, targetPath)).toBe(false);
  });
});

// End-to-end run against a real Steam client. Copies ~17 GB, so it only runs
// when ROTK_H1Z1_SOURCE points at one, e.g.
//   ROTK_H1Z1_SOURCE="C:\Program Files (x86)\Steam\steamapps\common\H1Z1" npx vitest run tests/installer.test.ts
const realSource = process.env.ROTK_H1Z1_SOURCE;

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

describe.skipIf(!realSource)("installer against a real H1Z1 client", () => {
  it("resumes after a cancel and leaves the Steam folder untouched", async () => {
    const source = realSource!;
    const root = await mkdtemp(join(process.env.ROTK_INSTALL_TEST_PARENT ?? tmpdir(), "rotk-install-"));
    roots.push(root);
    const destination = join(root, "Games", "ROTK");
    const patches = join(process.cwd(), "resources", "patches");
    const steamShimBefore = await sha256(join(source, "steam_api64.dll"));
    const steamVivoxBefore = await sha256(join(source, "vivoxsdk_x64.dll"));

    const request = (signal: AbortSignal, onProgress: Parameters<typeof installClient>[0]["onProgress"]) => ({
      sourceRoot: source,
      destinationRoot: destination,
      shimPath: join(patches, "steam_api64.dll"),
      vivoxProxyPath: join(patches, "vivoxsdk_x64.dll"),
      vivoxRuntimePath: join(patches, "vivoxsdk_x64_v5.dll"),
      launcherVersion: "test",
      signal,
      onProgress,
    });

    const cancel = new AbortController();
    let firstRunBytes = 0;
    await expect(installClient(request(cancel.signal, (progress) => {
      firstRunBytes = progress.completedBytes;
      if (progress.completedBytes > 3 * 1024 ** 3) cancel.abort(new DOMException("cancelled", "AbortError"));
    }))).rejects.toMatchObject({ name: "AbortError" });
    expect(await inspectDestination(destination)).toBe("pending");

    const started = Date.now();
    let resumedFrom = -1;
    const marker = await installClient(request(new AbortController().signal, (progress) => {
      if (resumedFrom < 0 && progress.phase === "copying") resumedFrom = progress.completedBytes;
    }));
    const seconds = (Date.now() - started) / 1000;
    console.info(`resumed from ${(resumedFrom / 1024 ** 3).toFixed(1)} GB (first run reached ${(firstRunBytes / 1024 ** 3).toFixed(1)} GB), finished in ${seconds.toFixed(0)} s`);

    expect(resumedFrom).toBeGreaterThan(0);
    expect(await readInstallationMarker(destination)).toMatchObject({ installId: marker.installId });
    await expect(stat(join(destination, INSTALL_PENDING_MARKER_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(destination, INSTALL_MARKER_NAME))).resolves.toBeTruthy();
    expect(await sha256(join(destination, "steam_api64.dll"))).toBe(await sha256(join(patches, "steam_api64.dll")));
    expect(await sha256(join(destination, "vivoxsdk_x64.dll"))).toBe(await sha256(join(patches, "vivoxsdk_x64.dll")));
    expect(await sha256(join(source, "steam_api64.dll"))).toBe(steamShimBefore);
    expect(await sha256(join(source, "vivoxsdk_x64.dll"))).toBe(steamVivoxBefore);

    // Installing again onto the finished folder repairs it in place.
    const again = await installClient(request(new AbortController().signal, () => undefined));
    expect(again.installId).toBe(marker.installId);
  }, 30 * 60_000);
});
