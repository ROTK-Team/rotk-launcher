import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetSyncService } from "../electron/services/asset-sync.js";
import {
  FEED_URL, assetEntry, assetStorage, installedClient, manifest, removeFixtures, routedFetch, sha256, type Route,
} from "./helpers/asset-sync-fixture.js";

afterEach(removeFixtures);

const marker = (installId: string): string => `${JSON.stringify({ schemaVersion: 1, installId })}\n`;

describe("asset state and the installation it describes", () => {
  const payload = Buffer.from("custom sounds");
  const feed = manifest([assetEntry("sounds.pack", payload)]);
  const routes: Record<string, Route> = {
    [FEED_URL]: () => new Response(JSON.stringify(feed)),
    [feed.assets[0].url]: () => new Response(payload),
  };

  it("starts afresh on another installation, so its originals are backed up and can be restored", async () => {
    const first = await installedClient(marker("install-a"));
    await writeFile(join(first.root, "sounds.pack"), "vanilla sounds");
    const sync = new AssetSyncService({ userDataDirectory: first.userData, feedUrl: FEED_URL, fetchImpl: routedFetch(routes) });
    await sync.sync(first.root);
    expect((await sync.readState())?.installId).toBe("install-a");

    // The client is installed again in another folder; the user data stays.
    const second = await installedClient(marker("install-b"));
    await writeFile(join(second.root, "sounds.pack"), "vanilla sounds");
    expect(await sync.sync(second.root)).toEqual({ status: "updated", packVersion: "1.0.0" });
    expect(await readFile(join(second.root, "sounds.pack"), "utf8")).toBe("custom sounds");
    // The old state called this file already replaced: no backup was taken here.
    expect(await readFile(join(assetStorage(second.root), "asset-backups", "sounds.pack"), "utf8")).toBe("vanilla sounds");
    expect((await sync.readState())?.installId).toBe("install-b");

    await sync.restore(second.root);
    // It used to be deleted: restored from a backup that did not exist.
    expect(await readFile(join(second.root, "sounds.pack"), "utf8")).toBe("vanilla sounds");
  });

  it("does not let a restore on one installation act on the files recorded for another", async () => {
    const first = await installedClient(marker("install-a"));
    const sync = new AssetSyncService({ userDataDirectory: first.userData, feedUrl: FEED_URL, fetchImpl: routedFetch(routes) });
    await sync.sync(first.root);

    const second = await installedClient(marker("install-b"));
    await writeFile(join(second.root, "sounds.pack"), "a game file of the other installation");
    await sync.restore(second.root);
    expect(existsSync(join(second.root, "sounds.pack"))).toBe(true);
  });

  it("keeps using a state written before installations were recorded", async () => {
    const { userData, root } = await installedClient(marker("install-a"));
    await writeFile(join(root, "sounds.pack"), payload);
    await writeFile(join(userData, "asset-state.v1.json"), JSON.stringify({
      schemaVersion: 1, packVersion: "1.0.0", syncedAt: "2026-11-01T00:00:00Z",
      assets: [{ name: "sounds.pack", version: "1.0.0", sha256: sha256(payload),
        installedFiles: [{ path: "sounds.pack", sha256: sha256(payload), size: payload.length }] }],
    }));
    const calls: string[] = [];
    const sync = new AssetSyncService({ userDataDirectory: userData, feedUrl: FEED_URL, fetchImpl: routedFetch(routes, calls) });
    // Up to date as recorded: nothing is downloaded, and the state is stamped from now on.
    expect(await sync.sync(root)).toEqual({ status: "up-to-date", packVersion: "1.0.0" });
    expect(calls).toEqual([FEED_URL]);
    expect((await sync.readState())?.installId).toBe("install-a");
  });

  it("leaves the state unstamped for an installation whose marker has no id", async () => {
    const { userData, root } = await installedClient();
    const sync = new AssetSyncService({ userDataDirectory: userData, feedUrl: FEED_URL, fetchImpl: routedFetch(routes) });
    await sync.sync(root);
    expect(await sync.readState()).not.toHaveProperty("installId");
  });
});
