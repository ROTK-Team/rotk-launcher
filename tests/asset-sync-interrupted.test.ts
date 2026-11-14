import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetSyncService } from "../electron/services/asset-sync.js";
import {
  FEED_URL, assetEntry, installedClient, manifest, removeFixtures, routedFetch, sha256, type Route,
} from "./helpers/asset-sync-fixture.js";

afterEach(removeFixtures);

const release = (version: string, name: string): string =>
  `https://github.com/rotk/rotk-assets/releases/download/assets-v${version}/${name}`;

describe("an asset update interrupted between two packs", () => {
  async function interrupted() {
    const { userData, root } = await installedClient();
    const a1 = Buffer.from("pack a v1"), b1 = Buffer.from("pack b v1");
    const a2 = Buffer.from("pack a v2!"), b2 = Buffer.from("pack b v2!");
    const first = manifest([assetEntry("a.pack", a1), assetEntry("b.pack", b1)]);
    const second = manifest([
      assetEntry("a.pack", a2, { version: "1.1.0", url: release("1.1.0", "a.pack") }),
      assetEntry("b.pack", b2, { version: "1.1.0", url: release("1.1.0", "b.pack") }),
    ], "1.1.0");
    const calls: string[] = [];
    const routes: Record<string, Route> = {
      [FEED_URL]: () => new Response(JSON.stringify(first)),
      [first.assets[0].url]: () => new Response(a1),
      [first.assets[1].url]: () => new Response(b1),
      [second.assets[0].url]: () => new Response(a2),
      // The second pack cannot be fetched: 404 is not retried.
      [second.assets[1].url]: () => new Response("gone", { status: 404 }),
    };
    const sync = new AssetSyncService({ userDataDirectory: userData, feedUrl: FEED_URL, fetchImpl: routedFetch(routes, calls) });
    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.0.0" });
    routes[FEED_URL] = () => new Response(JSON.stringify(second));
    await expect(sync.sync(root)).rejects.toThrow("HTTP 404");
    return { root, sync, routes, calls, second, b2 };
  }

  it("records the pack already in place, so the state still describes the disk", async () => {
    const { root, sync } = await interrupted();
    expect(await readFile(join(root, "a.pack"), "utf8")).toBe("pack a v2!");
    expect(await readFile(join(root, "b.pack"), "utf8")).toBe("pack b v1");

    const state = await sync.readState();
    // Not the new pack version yet: the update is not complete.
    expect(state?.packVersion).toBe("1.0.0");
    const recorded = Object.fromEntries((state?.assets ?? []).map((asset) => [asset.name, asset]));
    expect(recorded["a.pack"]).toMatchObject({ version: "1.1.0", installedFiles: [{ path: "a.pack", sha256: sha256("pack a v2!") }] });
    expect(recorded["b.pack"]).toMatchObject({ version: "1.0.0", installedFiles: [{ path: "b.pack", sha256: sha256("pack b v1") }] });
    // What the attestation reads: every recorded file has the recorded content.
    for (const asset of state?.assets ?? []) {
      for (const file of asset.installedFiles) {
        expect(sha256(await readFile(join(root, file.path)))).toBe(file.sha256);
      }
    }
  });

  it("only fetches and installs what is still missing on the next pass", async () => {
    const { root, sync, routes, calls, second, b2 } = await interrupted();
    routes[second.assets[1].url] = () => new Response(b2);
    calls.length = 0;
    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.1.0" });
    expect(calls).toEqual([FEED_URL, second.assets[1].url]);
    expect(await readFile(join(root, "b.pack"), "utf8")).toBe("pack b v2!");
    expect((await sync.readState())?.assets.map((asset) => `${asset.name}@${asset.version}`).sort())
      .toEqual(["a.pack@1.1.0", "b.pack@1.1.0"]);
  });

  it("keeps a first sync all or nothing", async () => {
    const { userData, root } = await installedClient();
    const a = Buffer.from("pack a"), b = Buffer.from("pack b");
    const feed = manifest([assetEntry("a.pack", a), assetEntry("b.pack", b)]);
    const sync = new AssetSyncService({ userDataDirectory: userData, feedUrl: FEED_URL, fetchImpl: routedFetch({
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(a),
      [feed.assets[1].url]: () => new Response("gone", { status: 404 }),
    }) });
    await expect(sync.sync(root)).rejects.toThrow("HTTP 404");
    // No state: a later launch without the feed must not pass for a completed sync.
    expect(await sync.readState()).toBeNull();
  });
});
