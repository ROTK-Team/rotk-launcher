import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_MARKER_NAME } from "../electron/constants.js";
import { ConfigStore } from "../electron/services/config-store.js";
import { folderSize } from "../electron/services/folder-size.js";
import { removeInstallation } from "../electron/services/installer.js";
import { speedLimiter } from "../electron/services/speed-limit.js";
import { DEFAULT_PREFERENCES, readPreferences, storedPreferences } from "../shared/preferences.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  // The physical path, as the launcher stores them: the temporary folder can be a short name or a link.
  const root = await realpath(await mkdtemp(join(tmpdir(), "vitest-settings-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exists = (path: string) => stat(path).then(() => true, () => false);

/** A ROTK installation as the installer leaves it, copied from `sourceRoot`. */
async function installation(root: string, installId: string, sourceRoot: string): Promise<{ root: string; installId: string }> {
  await mkdir(join(root, "Resources"), { recursive: true });
  await writeFile(join(root, "H1Z1.exe"), "game");
  await writeFile(join(root, "Resources", "Assets_000.pack"), "x".repeat(1000));
  await writeFile(join(root, INSTALL_MARKER_NAME), JSON.stringify({
    schemaVersion: 1, installId, clientBuildId: "build", sourceRoot, installedAt: "2026-11-14T00:00:00Z",
    launcherVersion: "2.0.51", patchVersion: "p", criticalHashes: {},
  }));
  return { root, installId };
}

describe("launcher preferences", () => {
  it("keeps what this build knows and refuses the rest as a whole", () => {
    expect(readPreferences({ closeBehavior: "tray", downloadSpeedLimit: 2 })).toEqual({ closeBehavior: "tray", downloadSpeedLimit: 2 });
    expect(readPreferences({})).toEqual({});
    expect(readPreferences({ closeBehavior: "tray", gameStartBehavior: "explode" })).toBeNull();
    expect(readPreferences({ downloadSpeedLimit: 3 })).toBeNull();
    expect(readPreferences({ startWithWindows: true })).toBeNull();
    expect(readPreferences(["tray"])).toBeNull();
    expect(readPreferences(null)).toBeNull();
    // A name every object answers to is not a preference.
    expect(readPreferences({ valueOf: 1 })).toBeNull();
  });

  it("reads the stored ones field by field, and leaves in the file what another version wrote", async () => {
    const directory = await temporaryRoot();
    const file = join(directory, "config.v1.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, preferences: { closeBehavior: "tray", downloadSpeedLimit: 3, startWithWindows: true, valueOf: 1 } }));
    const store = new ConfigStore(directory);
    expect(storedPreferences((await store.load()).preferences)).toEqual({ closeBehavior: "tray" });
    expect(storedPreferences(null)).toEqual({});

    await store.setPreferences({ notifications: false });
    expect(JSON.parse(await readFile(file, "utf8")).preferences)
      .toEqual({ closeBehavior: "tray", downloadSpeedLimit: 3, startWithWindows: true, valueOf: 1, notifications: false });
  });

  it("stores a change without touching the other preferences or the installation", async () => {
    const directory = await temporaryRoot();
    const store = new ConfigStore(directory);
    await store.setInstallation({ installId: "a", clientBuildId: "b", root: "D:\\Games\\ROTK", sourceRoot: "C:\\src", installedAt: "now", criticalHashes: {} });
    await store.setPreferences({ closeBehavior: "tray" });
    await store.setPreferences({ notifications: false });

    const reloaded = await new ConfigStore(directory).load();
    expect({ ...DEFAULT_PREFERENCES, ...reloaded.preferences }).toEqual({ ...DEFAULT_PREFERENCES, closeBehavior: "tray", notifications: false });
    expect(reloaded.installation?.root).toBe("D:\\Games\\ROTK");

    await store.clearInstallation();
    const cleared = await new ConfigStore(directory).load();
    expect(cleared.installation).toBeUndefined();
    expect(cleared.preferences).toEqual({ closeBehavior: "tray", notifications: false });
  });
});

describe("uninstalling the game", () => {
  it("deletes a copied installation and its asset storage, nothing around it", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "ROTK");
    const assets = join(parent, ".ROTK-assets");
    await mkdir(assets);
    await writeFile(join(assets, "pack.zip"), "cache");
    await writeFile(join(parent, "neighbour.txt"), "mine");

    expect(await removeInstallation(await installation(root, "id-1", join(parent, "source")), null, assets)).toBe("removed");
    expect(await readdir(parent)).toEqual(["neighbour.txt"]);
  });

  it("leaves a client adopted in place on the disk", async () => {
    const root = join(await temporaryRoot(), "H1Z1 ROTK");
    expect(await removeInstallation(await installation(root, "id-1", root), null)).toBe("kept");
    expect(await exists(join(root, "H1Z1.exe"))).toBe(true);
    expect(await exists(join(root, INSTALL_MARKER_NAME))).toBe(true);
  });

  it("leaves on the disk a client adopted, then moved and picked again where it is now", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "H1Z1 moved");
    // The marker still names the folder of the first adoption; the launcher's record names this one.
    const moved = await installation(root, "id-1", join(parent, "H1Z1 before"));
    expect(await removeInstallation({ ...moved, sourceRoot: root }, null)).toBe("kept");
    expect(await exists(join(root, "H1Z1.exe"))).toBe(true);
  });

  it("deletes nothing in a folder that is not this installation", async () => {
    const parent = await temporaryRoot();
    const other = await installation(join(parent, "ROTK"), "someone-else", join(parent, "source"));
    await expect(removeInstallation({ root: other.root, installId: "id-1" }, null)).rejects.toThrow(/rien n’a été supprimé/);

    const foreign = join(parent, "Documents");
    await mkdir(foreign);
    await writeFile(join(foreign, "notes.txt"), "mine");
    await expect(removeInstallation({ root: foreign, installId: "id-1" }, null)).rejects.toThrow(/rien n’a été supprimé/);
    expect(await exists(join(other.root, "H1Z1.exe"))).toBe(true);
    expect(await exists(join(foreign, "notes.txt"))).toBe(true);
  });

  it("refuses the launcher's own folder, and accepts a folder that is already gone", async () => {
    const parent = await temporaryRoot();
    const inside = await installation(join(parent, "Launcher", "ROTK"), "id-1", join(parent, "source"));
    await expect(removeInstallation(inside, join(parent, "Launcher"))).rejects.toThrow();
    expect(await exists(join(inside.root, "H1Z1.exe"))).toBe(true);

    const assets = join(parent, ".Gone-assets");
    await mkdir(assets);
    expect(await removeInstallation({ root: join(parent, "Gone"), installId: "id-1" }, null, assets)).toBe("removed");
    expect(await exists(assets)).toBe(false);
  });
});

describe("game folder size and download pacing", () => {
  it("adds up the files of a folder tree", async () => {
    const root = await temporaryRoot();
    await installation(join(root, "ROTK"), "id-1", "C:\\src");
    const marker = (await stat(join(root, "ROTK", INSTALL_MARKER_NAME))).size;
    expect(await folderSize(join(root, "ROTK"))).toBe(4 + 1000 + marker);
    expect(await folderSize(join(root, "missing"))).toBe(0);
  });

  it("holds a download to the limit, and lets it through without one", async () => {
    const send = async (limit: number): Promise<{ bytes: number; ms: number }> => {
      let bytes = 0;
      const startedAt = Date.now();
      await pipeline(
        Readable.from([Buffer.alloc(1000), Buffer.alloc(1000), Buffer.alloc(1000)]),
        speedLimiter(() => limit),
        new Writable({ write(chunk: Buffer, _encoding, callback) { bytes += chunk.byteLength; callback(); } }),
      );
      return { bytes, ms: Date.now() - startedAt };
    };
    // 3000 bytes at 10 000 bytes per second: about 300 ms.
    const limited = await send(10_000);
    expect(limited.bytes).toBe(3000);
    expect(limited.ms).toBeGreaterThanOrEqual(250);
    const free = await send(0);
    expect(free.bytes).toBe(3000);
    expect(free.ms).toBeLessThan(200);
  });

  it("keeps the speed asked for when the chunks are worth less than a timer tick", async () => {
    const send = async (limit: number): Promise<number> => {
      const startedAt = Date.now();
      await pipeline(
        Readable.from(Array.from({ length: 100 }, () => Buffer.alloc(500))),
        speedLimiter(() => limit),
        new Writable({ write(_chunk: Buffer, _encoding, callback) { callback(); } }),
      );
      return Date.now() - startedAt;
    };
    // 50 000 bytes in chunks worth 2.5 ms, then 5 ms: one sleep per chunk made both about as slow.
    const fast = await send(200_000);
    expect(fast).toBeGreaterThanOrEqual(200);
    expect(fast).toBeLessThan(400);
    const slow = await send(100_000);
    expect(slow).toBeGreaterThanOrEqual(450);
    expect(slow).toBeLessThan(700);
  });
});
