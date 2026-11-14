import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The next copy into the backup folder is cut short: half the bytes reach the
// destination, then the copy fails, like a launcher closed in the middle of it.
const interruption = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      const destination = String(args[1]);
      if (!interruption.armed || !destination.includes(`${sep}asset-backups${sep}`)) return fs.copyFile(...args);
      interruption.armed = false;
      const bytes = await fs.readFile(String(args[0]));
      await fs.writeFile(destination, bytes.subarray(0, Math.floor(bytes.length / 2)));
      throw Object.assign(new Error("EIO: i/o error, copyfile"), { code: "EIO" });
    },
  };
});

import { AssetSyncService } from "../electron/services/asset-sync.js";
import {
  FEED_URL, assetEntry, assetStorage, installedClient, manifest, removeFixtures, routedFetch,
} from "./helpers/asset-sync-fixture.js";

afterEach(async () => {
  interruption.armed = false;
  await removeFixtures();
});

describe("the backup of an original game file", () => {
  it("never keeps a copy that was cut short, and is made again on the next pass", async () => {
    const { userData, root } = await installedClient();
    await writeFile(join(root, "sounds.pack"), "the vanilla sounds of the game");
    const payload = Buffer.from("custom sounds");
    const feed = manifest([assetEntry("sounds.pack", payload)]);
    const sync = new AssetSyncService({ userDataDirectory: userData, feedUrl: FEED_URL, fetchImpl: routedFetch({
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(payload),
    }) });
    const backups = join(assetStorage(root), "asset-backups");

    interruption.armed = true;
    await expect(sync.sync(root)).rejects.toThrow();
    // The original is untouched, and no half backup waits under its final name.
    expect(await readFile(join(root, "sounds.pack"), "utf8")).toBe("the vanilla sounds of the game");
    expect(existsSync(join(backups, "sounds.pack"))).toBe(false);
    expect(await readdir(backups)).toEqual([]);

    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.0.0" });
    expect(await readFile(join(backups, "sounds.pack"), "utf8")).toBe("the vanilla sounds of the game");
    await sync.restore(root);
    expect(await readFile(join(root, "sounds.pack"), "utf8")).toBe("the vanilla sounds of the game");
  });
});
