import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetSyncService } from "../electron/services/asset-sync.js";
import {
  FEED_URL, assetEntry, assetStorage, installedClient, manifest, removeFixtures, routedFetch, type Route,
} from "./helpers/asset-sync-fixture.js";

afterEach(removeFixtures);

const down: Route = () => { throw new TypeError("fetch failed"); };

function service(userData: string, routes: Record<string, Route>, calls: string[] = [], reasons: string[] = []): AssetSyncService {
  return new AssetSyncService({
    userDataDirectory: userData,
    feedUrl: FEED_URL,
    fetchImpl: routedFetch(routes, calls),
    feedFallbackWaitMs: 60,
    onFeedUnavailable: (reason) => reasons.push(reason),
  });
}

describe("asset sync when the feed cannot be read", () => {
  it("repairs a damaged file from the packs on disk, with the last manifest the feed served", async () => {
    const { userData, root } = await installedClient();
    const payload = Buffer.from("pack contents");
    const feed = manifest([assetEntry("sounds.pack", payload)]);
    const routes: Record<string, Route> = {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(payload),
    };
    const calls: string[] = [], reasons: string[] = [];
    const sync = service(userData, routes, calls, reasons);
    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.0.0" });

    routes[FEED_URL] = down;
    await writeFile(join(root, "sounds.pack"), "PACK CONTENTS"); // same size, other bytes
    calls.length = 0;
    // "Verify files" used to return at once here, having checked nothing.
    expect(await sync.verify(root)).toEqual({ status: "offline-warning", packVersion: "1.0.0" });
    expect(await readFile(join(root, "sounds.pack"), "utf8")).toBe("pack contents");
    expect(calls).toEqual([FEED_URL]);
    expect(reasons).toEqual(["network"]);
  });

  it("leaves the client as it is when a pack it would need is neither cached nor downloadable", async () => {
    const { userData, root } = await installedClient();
    const first = Buffer.from("first pack"), second = Buffer.from("second pack");
    const feed = manifest([assetEntry("a.pack", first), assetEntry("b.pack", second)]);
    const routes: Record<string, Route> = {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(first),
      [feed.assets[1].url]: () => new Response(second),
    };
    const sync = service(userData, routes);
    await sync.sync(root);
    const before = await sync.readState();

    // Both files are damaged; only the first pack is still in the cache.
    routes[FEED_URL] = down;
    routes[feed.assets[1].url] = down;
    await writeFile(join(root, "a.pack"), "FIRST PACK");
    await writeFile(join(root, "b.pack"), "SECOND PACK");
    for (const entry of await readdir(join(assetStorage(root), "asset-cache"))) {
      if (entry.startsWith(feed.assets[1].sha256)) await rm(join(assetStorage(root), "asset-cache", entry));
    }
    expect(await sync.verify(root)).toEqual({ status: "offline-warning", packVersion: "1.0.0" });
    // Nothing half-done: the pack that could have been repaired was not touched either.
    expect(await readFile(join(root, "a.pack"), "utf8")).toBe("FIRST PACK");
    expect(await readFile(join(root, "b.pack"), "utf8")).toBe("SECOND PACK");
    expect(await sync.readState()).toEqual(before);
  }, 20_000);

  it("does not wait for a slow feed, and keeps its late answer for the next launch", async () => {
    const { userData, root } = await installedClient();
    const payload = Buffer.from("pack contents");
    const feed = manifest([assetEntry("sounds.pack", payload)]);
    const routes: Record<string, Route> = {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(payload),
    };
    const reasons: string[] = [];
    const sync = service(userData, routes, [], reasons);
    await sync.sync(root);

    const newer = manifest(feed.assets, "1.1.0");
    let answer!: (response: Response) => void;
    routes[FEED_URL] = () => new Promise<Response>((resolve) => { answer = resolve; });
    const started = Date.now();
    expect(await sync.sync(root)).toEqual({ status: "offline-warning", packVersion: "1.0.0" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(reasons).toEqual(["slow"]);

    answer(new Response(JSON.stringify(newer)));
    await expect.poll(async () =>
      JSON.parse(await readFile(join(userData, "asset-feed.v1.json"), "utf8")).packVersion).toBe("1.1.0");
  });

  it("installs an update the feed announced earlier, when its pack can still be downloaded", async () => {
    const { userData, root } = await installedClient();
    const oldPack = Buffer.from("old pack"), newPack = Buffer.from("new pack!");
    const feed = manifest([assetEntry("sounds.pack", oldPack)]);
    const routes: Record<string, Route> = {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(oldPack),
    };
    const sync = service(userData, routes);
    await sync.sync(root);

    // A newer manifest reached the disk (a late answer), then the feed went away.
    const newer = manifest([assetEntry("sounds.pack", newPack, { version: "1.1.0",
      url: "https://github.com/rotk/rotk-assets/releases/download/assets-v1.1.0/sounds.pack" })], "1.1.0");
    await writeFile(join(userData, "asset-feed.v1.json"), JSON.stringify(newer));
    routes[FEED_URL] = down;
    routes[newer.assets[0].url] = () => new Response(newPack);
    expect(await sync.sync(root)).toEqual({ status: "offline-warning", packVersion: "1.1.0" });
    expect(await readFile(join(root, "sounds.pack"), "utf8")).toBe("new pack!");
    expect((await sync.readState())?.packVersion).toBe("1.1.0");
  });

  it("still refuses a first sync, which has nothing to fall back on", async () => {
    const { userData, root } = await installedClient();
    const reasons: string[] = [];
    const sync = service(userData, { [FEED_URL]: () => new Response("nope", { status: 503 }) }, [], reasons);
    await expect(sync.sync(root)).rejects.toThrow("Le flux d’assets ROTK est indisponible");
    expect(reasons).toEqual(["HTTP 503"]);
    // A manifest that did not validate is never kept.
    const broken = service(userData, { [FEED_URL]: () => new Response("{}") });
    await expect(broken.sync(root)).rejects.toThrow("Manifeste");
    await expect(readFile(join(userData, "asset-feed.v1.json"), "utf8")).rejects.toThrow();
  });
});
