import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetSyncService,
  parseAssetManifest,
  stripByteOrderMark,
  type AssetManifest,
  type AssetManifestEntry,
  type CacheRetentionPolicy,
} from "../electron/services/asset-sync.js";
import { buildZip } from "./helpers/build-zip.js";

const faults = vi.hoisted(() => ({
  locked: null as { operation: "copyFile" | "rename"; path: string } | null,
  // When set, statfs reports this many free bytes on every drive.
  freeBytes: null as (() => Promise<number>) | null,
}));
// Until released, every copy from or rename onto the locked path fails with
// EPERM, like a file an antivirus holds for the whole attempt.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const fault = (operation: "copyFile" | "rename", path: string): NodeJS.ErrnoException | null => {
    if (faults.locked?.operation !== operation || faults.locked.path !== path) return null;
    return Object.assign(new Error(`EPERM: operation not permitted, ${operation} '${path}'`), { code: "EPERM" });
  };
  return {
    ...fs,
    copyFile: (...args: Parameters<typeof fs.copyFile>) => {
      const failure = fault("copyFile", String(args[0]));
      return failure ? Promise.reject(failure) : fs.copyFile(...args);
    },
    rename: (...args: Parameters<typeof fs.rename>) => {
      const failure = fault("rename", String(args[1]));
      return failure ? Promise.reject(failure) : fs.rename(...args);
    },
    statfs: async (...args: Parameters<typeof fs.statfs>) => {
      const disk = await fs.statfs(...args);
      return faults.freeBytes ? { ...disk, bavail: await faults.freeBytes(), bsize: 1 } : disk;
    },
  };
});

const FEED_URL = "https://raw.githubusercontent.com/rotk/rotk-assets/main/feed.json";
const INSTALL_MARKER_NAME = ".rotk-installation.json";

/** Where the launcher keeps cache and backups for an install root. */
function assetStorage(root: string): string {
  return join(dirname(root), `.${basename(root)}-assets`);
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function assetEntry(
  name: string,
  payload: Buffer,
  overrides: Partial<AssetManifestEntry> = {},
): AssetManifestEntry {
  return {
    name,
    version: "1.0.0",
    url: `https://github.com/rotk/rotk-assets/releases/download/assets-v1.0.0/${name}`,
    sha256: sha256(payload),
    size: payload.length,
    installPath: name,
    type: "file",
    ...overrides,
  };
}

function manifest(assets: AssetManifestEntry[], packVersion = "1.0.0"): AssetManifest {
  return { manifestVersion: 1, packVersion, assets };
}

type RouteHandler = () => Response;

function makeFetch(routes: Record<string, RouteHandler>, calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const handler = routes[url];
    if (!handler) throw new Error(`Unrouted fetch: ${url}`);
    return handler();
  }) as typeof fetch;
}

describe("ROTK asset sync", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    faults.locked = null;
    faults.freeBytes = null;
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  async function setup(): Promise<{ userData: string; root: string }> {
    const userData = await mkdtemp(join(tmpdir(), "rotk-asset-userdata-"));
    const root = await mkdtemp(join(tmpdir(), "rotk-asset-client-"));
    temporaryDirectories.push(userData, root, assetStorage(root));
    await writeFile(join(root, INSTALL_MARKER_NAME), "{}\n");
    return { userData, root };
  }

  function service(
    userData: string,
    routes: Record<string, RouteHandler>,
    calls: string[] = [],
  ): AssetSyncService {
    return new AssetSyncService({
      userDataDirectory: userData,
      feedUrl: FEED_URL,
      fetchImpl: makeFetch(routes, calls),
    });
  }

  it("propagates cancellation to the feed read", async () => {
    const { userData, root } = await setup();
    const controller = new AbortController();
    let started = 0, cancelled = 0;
    const sync = new AssetSyncService({ userDataDirectory: userData, feedUrl: FEED_URL,
      fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        started++;
        init!.signal!.addEventListener("abort", () => { cancelled++; reject(new Error("cancelled")); }, { once: true });
      })) as typeof fetch });
    const pending = expect(sync.sync(root, { signal: controller.signal })).rejects.toThrow();
    await vi.waitFor(() => expect(started).toBe(1));
    controller.abort();
    await pending;
    expect(cancelled).toBe(1);
  });

  it.each([false, true])("uses one timeout budget and respects an already-aborted signal (preaborted=%s)", async preaborted => {
    const { userData, root } = await setup();
    vi.useFakeTimers();
    const controller = new AbortController();
    if (preaborted) controller.abort();
    let markStarted!: () => void;
    const feedStarted = new Promise<void>(resolve => { markStarted = resolve; });
    let started = 0, cancelled = 0;
    const sync = new AssetSyncService({ userDataDirectory: userData, feedUrl: FEED_URL,
      fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        if (++started === 1) markStarted();
        const abort = () => { cancelled++; reject(new Error("cancelled")); };
        if (init!.signal!.aborted) abort();
        else init!.signal!.addEventListener("abort", abort, { once: true });
      })) as typeof fetch });
    const pending = expect(sync.sync(root, { signal: controller.signal })).rejects.toThrow();
    await feedStarted;
    if (!preaborted) {
      await vi.advanceTimersByTimeAsync(9999);
      expect(cancelled).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
    }
    await pending;
    expect(cancelled).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Verify files independently detects same-size ZIP content drift after streaming installation", async () => {
    const { userData, root } = await setup();
    const payload = buildZip([{ name: "test.dat", data: "original", method: 8 }]);
    const entry = assetEntry("stream.zip", payload, { type: "zip", installPath: "." });
    const sync = service(userData, { [FEED_URL]: () => new Response(JSON.stringify(manifest([entry]))),
      [entry.url]: () => new Response(new Uint8Array(payload)) });
    await sync.sync(root);
    await writeFile(join(root, "test.dat"), "tampered");
    expect((await sync.sync(root)).status).toBe("up-to-date");
    expect((await sync.verify(root)).status).toBe("updated");
    expect(await readFile(join(root, "test.dat"), "utf8")).toBe("original");
  });

  describe("manifest validation", () => {
    const payload = Buffer.from("payload");

    function withEntry(overrides: Partial<AssetManifestEntry>): AssetManifest {
      return manifest([assetEntry("pack.dat", payload, overrides)]);
    }

    it("accepts a valid manifest and normalizes the zip root", () => {
      const parsed = parseAssetManifest(manifest([
        assetEntry("ui-pack.zip", payload, { type: "zip", installPath: "." }),
        assetEntry("sounds.pack", payload, { installPath: "Resources/Assets/sounds.pack" }),
      ]));
      expect(parsed.assets[0].installPath).toBe(".");
      expect(parsed.assets[1].installPath).toBe("Resources/Assets/sounds.pack");
    });

    it("rejects insecure or third-party download URLs", () => {
      expect(() => parseAssetManifest(withEntry({ url: "http://github.com/x" }))).toThrow("URL invalide");
      expect(() => parseAssetManifest(withEntry({ url: "https://evil.example/x" }))).toThrow("hôte non autorisé");
      expect(() => parseAssetManifest(withEntry({ url: "https://user:pw@github.com/x" }))).toThrow("URL invalide");
    });

    it("rejects install paths escaping or targeting protected files", () => {
      expect(() => parseAssetManifest(withEntry({ installPath: "../outside.dat" }))).toThrow("chemin non autorisé");
      expect(() => parseAssetManifest(withEntry({ installPath: "C:/absolute.dat" }))).toThrow("chemin non autorisé");
      expect(() => parseAssetManifest(withEntry({ installPath: "a\\b.dat" }))).toThrow("chemin non autorisé");
      expect(() => parseAssetManifest(withEntry({ installPath: "mod.dll" }))).toThrow("extension interdite");
      expect(() => parseAssetManifest(withEntry({ installPath: "tool.exe" }))).toThrow("extension interdite");
      expect(() => parseAssetManifest(withEntry({ installPath: "ClientConfig.ini" }))).toThrow("fichier protégé");
      expect(() => parseAssetManifest(withEntry({ installPath: ".rotk-installation.json" }))).toThrow("fichier protégé");
      expect(() => parseAssetManifest(withEntry({ installPath: "BattlEye/config.cfg" }))).toThrow("chemin non autorisé");
      expect(() => parseAssetManifest(withEntry({ installPath: "dinput8.dll" }))).toThrow("fichier protégé");
      expect(() => parseAssetManifest(withEntry({ installPath: "steam_api64.original.dll" }))).toThrow("chemin non autorisé");
    });

    it("rejects duplicate assets, bad hashes and bad sizes", () => {
      const duplicated = manifest([assetEntry("a.dat", payload), assetEntry("a.dat", payload)]);
      expect(() => parseAssetManifest(duplicated)).toThrow("asset en double");
      expect(() => parseAssetManifest(withEntry({ sha256: "beef" }))).toThrow("sha256 invalide");
      expect(() => parseAssetManifest(withEntry({ size: 0 }))).toThrow("taille invalide");
      // A BOM-prefixed feed must still parse: Windows tooling emits one and it
      // would otherwise stop every launcher.
      expect(stripByteOrderMark("﻿{\"a\":1}")).toBe("{\"a\":1}");
      expect(stripByteOrderMark("{\"a\":1}")).toBe("{\"a\":1}");
      expect(JSON.parse(stripByteOrderMark("﻿{\"ok\":true}"))).toEqual({ ok: true });
      expect(() => parseAssetManifest(withEntry({ size: 4 * 1024 ** 4 }))).toThrow("taille invalide");
    });

  });

  it("restores backups made by older launchers and drops their C: cache", async () => {
    const { userData, root } = await setup();
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "sounds.pack"), "custom sounds");
    await mkdir(join(userData, "asset-backups", "data"), { recursive: true });
    await writeFile(join(userData, "asset-backups", "data", "sounds.pack"), "vanilla sounds");
    await mkdir(join(userData, "asset-cache"), { recursive: true });
    await writeFile(join(userData, "asset-cache", "old.pack"), "old");
    await writeFile(join(userData, "asset-state.v1.json"), JSON.stringify({
      schemaVersion: 1, packVersion: "0.9.0", syncedAt: "2026-09-01T00:00:00Z",
      assets: [{
        name: "rotk-sounds", version: "0.9.0", sha256: sha256("custom sounds"),
        installedFiles: [{ path: "data/sounds.pack", sha256: sha256("custom sounds"), size: 13 }],
      }],
    }));

    // The pack left the feed: the original comes back from the old backup.
    await service(userData, { [FEED_URL]: () => new Response(JSON.stringify(manifest([]))) }).sync(root);
    await expect(readFile(join(root, "data", "sounds.pack"), "utf8")).resolves.toBe("vanilla sounds");
    await expect(stat(join(userData, "asset-cache"))).rejects.toThrow();
    await expect(stat(join(userData, "asset-backups"))).rejects.toThrow();
  });

  it("moves backups made by older launchers next to the install", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("custom sounds");
    const entry = assetEntry("sounds.pack", payload, { installPath: "data/sounds.pack" });
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "sounds.pack"), "vanilla sounds");
    await mkdir(join(userData, "asset-backups", "data"), { recursive: true });
    await writeFile(join(userData, "asset-backups", "data", "sounds.pack"), "vanilla sounds");

    await service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(manifest([entry]))),
      [entry.url]: () => new Response(payload),
    }).sync(root);
    expect(await readFile(join(root, "data", "sounds.pack"), "utf8")).toBe("custom sounds");
    expect(await readFile(join(assetStorage(root), "asset-backups", "data", "sounds.pack"), "utf8")).toBe("vanilla sounds");
    await expect(stat(join(userData, "asset-backups"))).rejects.toThrow();
  });

  it("reuses packs from the old userData cache without downloading them", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("cached sounds");
    const entry = assetEntry("sounds.pack", payload);
    await mkdir(join(userData, "asset-cache"), { recursive: true });
    await writeFile(join(userData, "asset-cache", `${entry.sha256}.pack`), payload);
    const calls: string[] = [];
    await service(userData, { [FEED_URL]: () => new Response(JSON.stringify(manifest([entry]))) }, calls).sync(root);
    expect(calls).toEqual([FEED_URL]);
    await expect(readFile(join(root, "sounds.pack"), "utf8")).resolves.toBe("cached sounds");
    await expect(stat(join(assetStorage(root), "asset-cache", `${entry.sha256}.pack`))).resolves.toBeTruthy();
    await expect(stat(join(userData, "asset-cache"))).rejects.toThrow();
  });

  // The old cache sits in %APPDATA% (C:); the game is often on another drive.
  const otherDrive = ["D:\\", "E:\\"].find((drive) =>
    drive[0].toLowerCase() !== tmpdir()[0].toLowerCase() && existsSync(drive));
  it.skipIf(!otherDrive)("moves the old cache and backups to another drive and only then deletes them", async () => {
    const userData = await mkdtemp(join(tmpdir(), "rotk-asset-userdata-"));
    const root = await mkdtemp(join(otherDrive!, "rotk-asset-client-"));
    temporaryDirectories.push(userData, root, assetStorage(root));
    await writeFile(join(root, INSTALL_MARKER_NAME), "{}\n");
    const payload = Buffer.from("cached sounds");
    const entry = assetEntry("sounds.pack", payload);
    await mkdir(join(userData, "asset-cache"), { recursive: true });
    await writeFile(join(userData, "asset-cache", `${entry.sha256}.pack`), payload);
    await writeFile(join(userData, "asset-cache", "obsolete.pack"), "old");
    await mkdir(join(userData, "asset-backups", "data"), { recursive: true });
    await writeFile(join(userData, "asset-backups", "data", "other.pack"), "vanilla other");

    const calls: string[] = [];
    await service(userData, { [FEED_URL]: () => new Response(JSON.stringify(manifest([entry]))) }, calls).sync(root);
    expect(calls).toEqual([FEED_URL]);
    expect(await readFile(join(assetStorage(root), "asset-cache", `${entry.sha256}.pack`), "utf8")).toBe("cached sounds");
    await expect(stat(join(userData, "asset-cache"))).rejects.toThrow();
    expect(await readFile(join(assetStorage(root), "asset-backups", "data", "other.pack"), "utf8")).toBe("vanilla other");
    await expect(stat(join(userData, "asset-backups"))).rejects.toThrow();
  });

  it("resumes a partial download with a Range request", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("0123456789".repeat(100));
    const entry = assetEntry("big.pack", payload, { installPath: "data/big.pack" });
    const cacheDirectory = join(assetStorage(root), "asset-cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, `${entry.sha256}.pack.part`), payload.subarray(0, 400));
    const ranges: Array<string | null> = [];
    const sync = new AssetSyncService({
      userDataDirectory: userData,
      feedUrl: FEED_URL,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === FEED_URL) return new Response(JSON.stringify(manifest([entry])));
        const range = new Headers(init?.headers).get("range");
        ranges.push(range);
        if (range !== "bytes=400-") return new Response(new Uint8Array(payload));
        return new Response(new Uint8Array(payload.subarray(400)), {
          status: 206,
          headers: { "content-range": `bytes 400-999/${payload.length}` },
        });
      }) as typeof fetch,
    });

    await sync.sync(root);
    expect(ranges).toEqual(["bytes=400-"]);
    expect(await readFile(join(root, "data", "big.pack"))).toEqual(payload);
  });

  it("restarts a corrupt resumed download without overcounting progress", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("0123456789".repeat(100));
    const entry = assetEntry("big.pack", payload, { installPath: "data/big.pack" });
    const cacheDirectory = join(assetStorage(root), "asset-cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, `${entry.sha256}.pack.part`), Buffer.alloc(400, 0x78));
    const ranges: Array<string | null> = [];
    const progress: Array<{ completedBytes: number; totalBytes: number }> = [];
    const sync = new AssetSyncService({
      userDataDirectory: userData,
      feedUrl: FEED_URL,
      onProgress: (event) => progress.push(event),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === FEED_URL) return new Response(JSON.stringify(manifest([entry])));
        const range = new Headers(init?.headers).get("range");
        ranges.push(range);
        if (range !== "bytes=400-") return new Response(new Uint8Array(payload));
        return new Response(new Uint8Array(payload.subarray(400)), {
          status: 206,
          headers: { "content-range": `bytes 400-999/${payload.length}` },
        });
      }) as typeof fetch,
    });

    await sync.sync(root);
    expect(ranges).toEqual(["bytes=400-", null]);
    expect(await readFile(join(root, "data", "big.pack"))).toEqual(payload);
    expect(Math.max(...progress.map((event) => event.completedBytes))).toBe(payload.length);
    expect(progress.every((event) => event.completedBytes <= event.totalBytes)).toBe(true);
  });

  it("drops a partial answer for another offset and retries without Range", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("0123456789".repeat(100));
    const entry = assetEntry("big.pack", payload, { installPath: "data/big.pack" });
    const cacheDirectory = join(assetStorage(root), "asset-cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, `${entry.sha256}.pack.part`), payload.subarray(0, 400));
    const ranges: Array<string | null> = [];
    const sync = new AssetSyncService({
      userDataDirectory: userData,
      feedUrl: FEED_URL,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === FEED_URL) return new Response(JSON.stringify(manifest([entry])));
        const range = new Headers(init?.headers).get("range");
        ranges.push(range);
        if (range === null) return new Response(new Uint8Array(payload));
        return new Response(new Uint8Array(payload.subarray(0, 600)), {
          status: 206,
          headers: { "content-range": `bytes 0-599/${payload.length}` },
        });
      }) as typeof fetch,
    });

    await sync.sync(root);
    expect(ranges).toEqual(["bytes=400-", null]);
    expect(await readFile(join(root, "data", "big.pack"))).toEqual(payload);
  });

  it("retries a download after a server error", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("custom sounds");
    const entry = assetEntry("sounds.pack", payload);
    let downloads = 0;
    const sync = new AssetSyncService({
      userDataDirectory: userData,
      feedUrl: FEED_URL,
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input) === FEED_URL) return new Response(JSON.stringify(manifest([entry])));
        downloads += 1;
        return downloads === 1 ? new Response("busy", { status: 503 }) : new Response(new Uint8Array(payload));
      }) as typeof fetch,
    });

    await sync.sync(root);
    expect(downloads).toBe(2);
    await expect(readFile(join(root, "sounds.pack"), "utf8")).resolves.toBe("custom sounds");
  });

  it("does not retry a missing asset", async () => {
    const { userData, root } = await setup();
    const entry = assetEntry("gone.pack", Buffer.from("x"));
    let downloads = 0;
    const sync = new AssetSyncService({
      userDataDirectory: userData,
      feedUrl: FEED_URL,
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input) === FEED_URL) return new Response(JSON.stringify(manifest([entry])));
        downloads += 1;
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });

    await expect(sync.sync(root)).rejects.toThrow(/HTTP 404/);
    expect(downloads).toBe(1);
  });

  it("installs file and zip assets, backs up originals and keeps state", async () => {
    const { userData, root } = await setup();
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "sounds.pack"), "vanilla sounds");

    const soundsPayload = Buffer.from("custom sounds");
    const zipPayload = buildZip([
      { name: "Resources/", directory: true },
      { name: "Resources/texture.dat", data: "custom texture", method: 8 },
    ]);
    const feed = manifest([
      assetEntry("rotk-sounds", soundsPayload, { installPath: "data/sounds.pack" }),
      assetEntry("rotk-ui", zipPayload, { type: "zip", installPath: "." }),
    ]);
    const calls: string[] = [];
    const routes: Record<string, RouteHandler> = {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(soundsPayload),
      [feed.assets[1].url]: () => new Response(new Uint8Array(zipPayload)),
    };

    const sync = service(userData, routes, calls);
    const outcome = await sync.sync(root);
    expect(outcome).toEqual({ status: "updated", packVersion: "1.0.0" });
    expect(await readFile(join(root, "data", "sounds.pack"), "utf8")).toBe("custom sounds");
    expect(await readFile(join(root, "Resources", "texture.dat"), "utf8")).toBe("custom texture");
    expect(await readFile(join(assetStorage(root), "asset-backups", "data", "sounds.pack"), "utf8")).toBe("vanilla sounds");

    const state = await sync.readState();
    expect(state?.packVersion).toBe("1.0.0");
    expect(state?.assets.map((asset) => asset.name)).toEqual(["rotk-sounds", "rotk-ui"]);
    expect(state?.assets[1].installedFiles).toEqual([
      { path: "Resources/texture.dat", sha256: sha256("custom texture"), size: 14 },
    ]);

    // Unchanged feed: nothing is downloaded again.
    calls.length = 0;
    expect(await sync.sync(root)).toEqual({ status: "up-to-date", packVersion: "1.0.0" });
    expect(calls).toEqual([FEED_URL]);
  }, 20_000); // Two real syncs with backups can exceed 5s on a busy Windows CI runner.

  it("repairs a missing installed file from the local cache without re-downloading", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("repairable");
    const feed = manifest([assetEntry("repair.dat", payload)]);
    const calls: string[] = [];
    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(payload),
    }, calls);

    await sync.sync(root);
    await rm(join(root, "repair.dat"));
    calls.length = 0;

    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.0.0" });
    expect(await readFile(join(root, "repair.dat"), "utf8")).toBe("repairable");
    expect(calls).toEqual([FEED_URL]);
  });

  describe("packs a release replaced", () => {
    const GiB = 1024 ** 3;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const payloads = new Map<string, Buffer>();

    /** A feed where each pack's payload is its text, served from its own release. */
    function release(version: string, packs: Record<string, string>): AssetManifest {
      return manifest(Object.entries(packs).map(([name, text]) => {
        const payload = Buffer.from(text);
        const entry = assetEntry(name, payload, {
          version,
          url: `https://github.com/rotk/rotk-assets/releases/download/assets-v${version}/${name}.payload`,
          installPath: `Resources/Assets/${name}.pack2`,
        });
        payloads.set(entry.url, payload);
        return entry;
      }), version);
    }

    function releaseService(
      userData: string,
      feed: { current: AssetManifest },
      calls: string[] = [],
      cacheRetention?: Partial<CacheRetentionPolicy>,
    ): AssetSyncService {
      return new AssetSyncService({
        userDataDirectory: userData,
        feedUrl: FEED_URL,
        cacheRetention,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          calls.push(url);
          if (url === FEED_URL) return new Response(JSON.stringify(feed.current));
          const payload = payloads.get(url);
          if (!payload) throw new Error(`Unrouted fetch: ${url}`);
          return new Response(new Uint8Array(payload));
        }) as typeof fetch,
      });
    }

    function cached(root: string, text: string): string {
      return join(assetStorage(root), "asset-cache", `${sha256(text)}.pack`);
    }

    function indexPath(root: string): string {
      return join(assetStorage(root), "asset-cache", "replaced-packs.v1.json");
    }

    async function cacheEntries(root: string): Promise<string[]> {
      return (await readdir(join(assetStorage(root), "asset-cache"))).sort();
    }

    it("installs the packs a release goes back to from the cache", async () => {
      const { userData, root } = await setup();
      faults.freeBytes = async () => 100 * GiB;
      // Shaped like 1.13.56 to 1.13.59: an event replaces two packs, changes one
      // of them twice, then the next release goes back to both and adds one.
      const before = release("1.13.56", { assets_x64_0: "assets base", data_x64_0: "data base" });
      const event1 = release("1.13.57", { assets_x64_0: "assets event", data_x64_0: "data event 1" });
      const event2 = release("1.13.58", { assets_x64_0: "assets event", data_x64_0: "data event 2" });
      const after = release("1.13.59", { assets_x64_0: "assets base", data_x64_0: "data base", z2_x64_0: "z2 new" });
      const feed = { current: before };
      const calls: string[] = [];
      const sync = releaseService(userData, feed, calls);
      for (const next of [before, event1, event2]) {
        feed.current = next;
        await sync.sync(root);
      }
      // A download of a replaced pack that never finished is not kept.
      const abandoned = `${cached(root, "never finished")}.part`;
      await writeFile(abandoned, "never");

      calls.length = 0;
      feed.current = after;
      expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.13.59" });
      expect(calls).toEqual([FEED_URL, after.assets[2].url]);
      const installed = join(root, "Resources", "Assets");
      expect(await readFile(join(installed, "assets_x64_0.pack2"), "utf8")).toBe("assets base");
      expect(await readFile(join(installed, "data_x64_0.pack2"), "utf8")).toBe("data base");
      expect(await readFile(join(installed, "z2_x64_0.pack2"), "utf8")).toBe("z2 new");
      // Both event versions of the data pack are kept, not only the last one.
      expect(existsSync(cached(root, "assets event"))).toBe(true);
      expect(existsSync(cached(root, "data event 1"))).toBe(true);
      expect(existsSync(cached(root, "data event 2"))).toBe(true);
      expect(existsSync(abandoned)).toBe(false);
    });

    it("drops a replaced pack 30 days after it left the feed", async () => {
      const { userData, root } = await setup();
      faults.freeBytes = async () => 100 * GiB;
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.parse("2026-11-01T00:00:00Z");
      vi.setSystemTime(start);
      const feed = { current: release("1.20.0", { pack: "before event" }) };
      const sync = releaseService(userData, feed);
      await sync.sync(root);

      // Downloaded 60 days before it is replaced: the 30 days count from the replacement.
      vi.setSystemTime(start + 60 * DAY_MS);
      feed.current = release("1.21.0", { pack: "during event" });
      await sync.sync(root);
      vi.setSystemTime(start + 89 * DAY_MS);
      await sync.sync(root);
      expect(existsSync(cached(root, "before event"))).toBe(true);

      vi.setSystemTime(start + 91 * DAY_MS);
      expect(await sync.sync(root)).toEqual({ status: "up-to-date", packVersion: "1.21.0" });
      expect(existsSync(cached(root, "before event"))).toBe(false);
      expect(existsSync(cached(root, "during event"))).toBe(true);
    });

    it("keeps at most maxBytes of replaced packs, the oldest replaced going first", async () => {
      const { userData, root } = await setup();
      faults.freeBytes = async () => 100 * GiB;
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.parse("2026-11-01T00:00:00Z");
      const texts = ["release 1.30", "release 1.31", "release 1.32", "release 1.33"];
      const feed = { current: manifest([]) };
      // Room for two of these 12-byte packs.
      const sync = releaseService(userData, feed, [], { maxBytes: 30 });
      for (const [step, text] of texts.entries()) {
        vi.setSystemTime(start + step * 60 * 60 * 1000);
        feed.current = release(`1.3${step}.0`, { pack: text });
        await sync.sync(root);
      }
      expect(existsSync(cached(root, "release 1.30"))).toBe(false);
      expect(existsSync(cached(root, "release 1.31"))).toBe(true);
      expect(existsSync(cached(root, "release 1.32"))).toBe(true);
      expect(existsSync(cached(root, "release 1.33"))).toBe(true);
      const index = JSON.parse(await readFile(indexPath(root), "utf8")) as { packs: Array<{ sha256: string }> };
      expect(index.packs.map((pack) => pack.sha256)).toEqual([sha256("release 1.32"), sha256("release 1.31")]);
    });

    it("drops the replaced packs when an update would not fit otherwise, then checks again", async () => {
      const { userData, root } = await setup();
      faults.freeBytes = async () => 100 * GiB;
      const feed = { current: release("1.40.0", { pack: "pack 1.40" }) };
      const sync = releaseService(userData, feed);
      await sync.sync(root);
      feed.current = release("1.41.0", { pack: "pack 1.41" });
      await sync.sync(root);
      expect(existsSync(cached(root, "pack 1.40"))).toBe(true);

      // Three times the new pack is needed: one byte short while the old pack is there.
      feed.current = release("1.42.0", { pack: "a bigger pack 1.42" });
      const needed = 3 * feed.current.assets[0].size;
      faults.freeBytes = async () => needed - 1 + (existsSync(cached(root, "pack 1.40")) ? 0 : 1);
      expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.42.0" });
      expect(await readFile(join(root, "Resources", "Assets", "pack.pack2"), "utf8")).toBe("a bigger pack 1.42");
      // The drive stays low on space: the pack replaced now is not kept either.
      expect(await cacheEntries(root)).toEqual(
        [`${sha256("a bigger pack 1.42")}.pack`, "replaced-packs.v1.json"].sort());
    });

    it("keeps nothing replaced while the drive has less than 10 GiB free", async () => {
      const { userData, root } = await setup();
      faults.freeBytes = async () => 100 * GiB;
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.parse("2026-11-01T00:00:00Z");
      const feed = { current: manifest([]) };
      const sync = releaseService(userData, feed);
      for (const [step, version] of ["1.50", "1.51", "1.52"].entries()) {
        vi.setSystemTime(start + step * 60 * 60 * 1000);
        feed.current = release(`${version}.0`, { pack: `pack ${version}` });
        await sync.sync(root);
      }
      expect(existsSync(cached(root, "pack 1.50"))).toBe(true);
      expect(existsSync(cached(root, "pack 1.51"))).toBe(true);

      // Dropping the oldest (9 bytes) is enough to get back to 10 GiB.
      faults.freeBytes = async () => 10 * GiB - 1;
      await sync.sync(root);
      expect(existsSync(cached(root, "pack 1.50"))).toBe(false);
      expect(existsSync(cached(root, "pack 1.51"))).toBe(true);

      faults.freeBytes = async () => 2 * GiB;
      await sync.sync(root);
      expect(await cacheEntries(root)).toEqual([`${sha256("pack 1.52")}.pack`, "replaced-packs.v1.json"].sort());
    });

    it.each([
      ["corrupt", "{ not json"],
      ["invalid", JSON.stringify({ schemaVersion: 1, packs: [{ sha256: "beef", replacedAt: "soon" }] })],
      ["missing", null],
    ])("uses the file dates when the index is %s", async (_kind, content) => {
      const { userData, root } = await setup();
      faults.freeBytes = async () => 100 * GiB;
      const feed = { current: manifest([]) };
      const sync = releaseService(userData, feed);
      for (const version of ["1.60", "1.61", "1.62"]) {
        feed.current = release(`${version}.0`, { pack: `pack ${version}` });
        await sync.sync(root);
      }
      if (content === null) await rm(indexPath(root));
      else await writeFile(indexPath(root), content);
      const longAgo = new Date(Date.now() - 40 * DAY_MS);
      await utimes(cached(root, "pack 1.60"), longAgo, longAgo);

      expect(await sync.sync(root)).toEqual({ status: "up-to-date", packVersion: "1.62.0" });
      // Written 40 days ago, so replaced at least that long ago.
      expect(existsSync(cached(root, "pack 1.60"))).toBe(false);
      expect(existsSync(cached(root, "pack 1.61"))).toBe(true);
      const index = JSON.parse(await readFile(indexPath(root), "utf8")) as { packs: Array<{ sha256: string }> };
      expect(index.packs.map((pack) => pack.sha256)).toEqual([sha256("pack 1.61")]);
    });
  });

  it("normal sync detects same-size drift in a standalone file asset", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("pristine-content");
    const feed = manifest([assetEntry("check.dat", payload)]);
    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(payload),
    });

    await sync.sync(root);
    // Same size, different bytes: standalone files are still hashed during the
    // normal pre-launch sync so attestation never sees the stale copy.
    await writeFile(join(root, "check.dat"), "tampered-content");
    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.0.0" });
    expect(await readFile(join(root, "check.dat"), "utf8")).toBe("pristine-content");
  });

  it("Verify files repairs both 1.5.0 weapon banks after same-size drift", async () => {
    const { userData, root } = await setup();
    const audioRoot = join(root, "Resources", "Audio", "pc9");
    await mkdir(audioRoot, { recursive: true });

    const weapons = Buffer.from("rotk-weapons-bank");
    const weaponsSfx = Buffer.from("rotk-weapons-sfx-bank");
    const feed = manifest([
      assetEntry("weapons_bank_pc9", weapons, {
        version: "1.5.0",
        url: "https://github.com/h1z1rotk/assets/releases/download/assets-v1.5.0/Weapons.bnk_pc",
        installPath: "Resources/Audio/pc9/Weapons.bnk_pc",
      }),
      assetEntry("weapons_sfx_bank_pc9", weaponsSfx, {
        version: "1.5.0",
        url: "https://github.com/h1z1rotk/assets/releases/download/assets-v1.5.0/Weapons_SFX.bnk_pc",
        installPath: "Resources/Audio/pc9/Weapons_SFX.bnk_pc",
      }),
    ], "1.5.0");
    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(weapons),
      [feed.assets[1].url]: () => new Response(weaponsSfx),
    });

    await sync.sync(root);
    await writeFile(join(audioRoot, "Weapons.bnk_pc"), Buffer.alloc(weapons.length, 0x76));
    await writeFile(join(audioRoot, "Weapons_SFX.bnk_pc"), Buffer.alloc(weaponsSfx.length, 0x73));

    expect(await sync.verify(root)).toEqual({ status: "updated", packVersion: "1.5.0" });
    expect(await readFile(join(audioRoot, "Weapons.bnk_pc"))).toEqual(weapons);
    expect(await readFile(join(audioRoot, "Weapons_SFX.bnk_pc"))).toEqual(weaponsSfx);
  });

  it("never installs a download whose SHA-256 does not match the manifest", async () => {
    const { userData, root } = await setup();
    const announced = Buffer.from("announced-bytes");
    const feed = manifest([assetEntry("evil.dat", announced)]);
    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(Buffer.from("swapped-bytes!!")),
    });

    await expect(sync.sync(root)).rejects.toThrow("est corrompu");
    await expect(stat(join(root, "evil.dat"))).rejects.toThrow();
    expect(await sync.readState()).toBeNull();
    const cacheEntries = await readdir(join(assetStorage(root), "asset-cache"));
    expect(cacheEntries).toEqual([]);
  });

  it("blocks only a first sync when the feed is unreachable", async () => {
    const { userData, root } = await setup();
    const failing = service(userData, {});
    await expect(failing.sync(root)).rejects.toThrow("indisponible");

    const payload = Buffer.from("online-once");
    const feed = manifest([assetEntry("pack.dat", payload)]);
    const online = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(payload),
    });
    await online.sync(root);

    const offlineAgain = service(userData, {});
    expect(await offlineAgain.sync(root)).toEqual({
      status: "offline-warning",
      packVersion: "1.0.0",
    });
    expect(await readFile(join(root, "pack.dat"), "utf8")).toBe("online-once");
  });

  it("follows GitHub release redirects but refuses foreign hosts", async () => {
    const { userData, root } = await setup();
    const payload = Buffer.from("released");
    const feed = manifest([assetEntry("release.dat", payload)]);
    const mirror = "https://objects.githubusercontent.com/signed/release.dat";
    const good = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => Response.redirect(mirror, 302),
      [mirror]: () => new Response(payload),
    });
    await good.sync(root);
    expect(await readFile(join(root, "release.dat"), "utf8")).toBe("released");

    const { userData: userData2, root: root2 } = await setup();
    const evil = service(userData2, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => Response.redirect("https://evil.example/release.dat", 302),
    });
    await expect(evil.sync(root2)).rejects.toThrow("Hôte de téléchargement d’assets non autorisé");
    await expect(stat(join(root2, "release.dat"))).rejects.toThrow();
  });

  it("rejects a zip pack containing traversal entries or executable files", async () => {
    const { userData, root } = await setup();
    const slipZip = buildZip([{ name: "../escape.txt", data: "boom" }]);
    const slipFeed = manifest([assetEntry("slip", slipZip, { type: "zip", installPath: "." })]);
    const slip = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(slipFeed)),
      [slipFeed.assets[0].url]: () => new Response(new Uint8Array(slipZip)),
    });
    await expect(slip.sync(root)).rejects.toThrow("Archive d’assets invalide");
    await expect(stat(join(dirname(root), "escape.txt"))).rejects.toThrow();

    const { userData: userData2, root: root2 } = await setup();
    const dllZip = buildZip([{ name: "innocent.dat", data: "ok" }, { name: "mod.dll", data: "MZ" }]);
    const dllFeed = manifest([assetEntry("dll-pack", dllZip, { type: "zip", installPath: "." })]);
    const dll = service(userData2, {
      [FEED_URL]: () => new Response(JSON.stringify(dllFeed)),
      [dllFeed.assets[0].url]: () => new Response(new Uint8Array(dllZip)),
    });
    await expect(dll.sync(root2)).rejects.toThrow("extension interdite");
    // The offending pack is rejected as a whole, before any file lands.
    await expect(stat(join(root2, "innocent.dat"))).rejects.toThrow();
  });

  it("removes assets dropped from the feed and restores backed-up originals", async () => {
    const { userData, root } = await setup();
    await writeFile(join(root, "overlay.pack"), "vanilla overlay");
    const payload = Buffer.from("custom overlay");
    const feedV1 = manifest([assetEntry("overlay", payload, { installPath: "overlay.pack" })]);
    const first = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feedV1)),
      [feedV1.assets[0].url]: () => new Response(payload),
    });
    await first.sync(root);
    expect(await readFile(join(root, "overlay.pack"), "utf8")).toBe("custom overlay");

    const second = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(manifest([], "2.0.0"))),
    });
    expect(await second.sync(root)).toEqual({ status: "updated", packVersion: "2.0.0" });
    expect(await readFile(join(root, "overlay.pack"), "utf8")).toBe("vanilla overlay");
  });

  it("restore() returns the client to vanilla and forgets the sync state", async () => {
    const { userData, root } = await setup();
    await writeFile(join(root, "replaced.pack"), "vanilla bytes");
    const replaced = Buffer.from("custom bytes!");
    const added = Buffer.from("brand new");
    const feed = manifest([
      assetEntry("replaced", replaced, { installPath: "replaced.pack" }),
      assetEntry("added", added, { installPath: "added.pack" }),
    ]);
    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(replaced),
      [feed.assets[1].url]: () => new Response(added),
    });
    await sync.sync(root);

    await sync.restore(root);
    expect(await readFile(join(root, "replaced.pack"), "utf8")).toBe("vanilla bytes");
    await expect(stat(join(root, "added.pack"))).rejects.toThrow();
    expect(await sync.readState()).toBeNull();
    await expect(stat(join(assetStorage(root), "asset-backups"))).rejects.toThrow();
  });

  it("restore() retried after an interrupted pass keeps every restored original", async () => {
    const { userData, root } = await setup();
    await writeFile(join(root, "first.pack"), "vanilla first");
    await writeFile(join(root, "second.pack"), "vanilla second");
    const first = Buffer.from("custom first");
    const second = Buffer.from("custom second");
    const added = Buffer.from("brand new");
    const feed = manifest([
      assetEntry("first", first, { installPath: "first.pack" }),
      assetEntry("second", second, { installPath: "second.pack" }),
      assetEntry("added", added, { installPath: "added.pack" }),
    ]);
    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feed)),
      [feed.assets[0].url]: () => new Response(first),
      [feed.assets[1].url]: () => new Response(second),
      [feed.assets[2].url]: () => new Response(added),
    });
    await sync.sync(root);

    // A locked second file stops the first attempt after the first file is back.
    faults.locked = { operation: "rename", path: join(root, "second.pack") };
    await expect(sync.restore(root)).rejects.toMatchObject({ code: "EPERM" });
    faults.locked = null;
    expect(await readFile(join(root, "first.pack"), "utf8")).toBe("vanilla first");
    expect(await readFile(join(root, "second.pack"), "utf8")).toBe("custom second");
    expect(await sync.readState()).not.toBeNull();

    await sync.restore(root);
    expect(await readFile(join(root, "first.pack"), "utf8")).toBe("vanilla first");
    expect(await readFile(join(root, "second.pack"), "utf8")).toBe("vanilla second");
    expect((await readdir(root)).sort()).toEqual([INSTALL_MARKER_NAME, "first.pack", "second.pack"]);
    expect(await sync.readState()).toBeNull();
    await expect(stat(join(assetStorage(root), "asset-backups"))).rejects.toThrow();
  });

  it("keeps the backups of a dropped asset until the state without it is written", async () => {
    const { userData, root } = await setup();
    await writeFile(join(root, "first.pack"), "vanilla first");
    await writeFile(join(root, "second.pack"), "vanilla second");
    const zipPayload = buildZip([
      { name: "first.pack", data: "custom first", method: 8 },
      { name: "second.pack", data: "custom second", method: 8 },
    ]);
    const feedV1 = manifest([assetEntry("overlay", zipPayload, { type: "zip", installPath: "." })]);
    await service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feedV1)),
      [feedV1.assets[0].url]: () => new Response(new Uint8Array(zipPayload)),
    }).sync(root);

    const backups = join(assetStorage(root), "asset-backups");
    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(manifest([], "2.0.0"))),
    });
    // Reading the second backup fails, after the first file is back.
    faults.locked = { operation: "copyFile", path: join(backups, "second.pack") };
    await expect(sync.sync(root)).rejects.toMatchObject({ code: "EPERM" });
    faults.locked = null;
    expect(await readFile(join(root, "first.pack"), "utf8")).toBe("vanilla first");
    expect(await readFile(join(root, "second.pack"), "utf8")).toBe("custom second");
    expect((await sync.readState())?.packVersion).toBe("1.0.0");

    // Writing the new state fails: the previous state still lists both files,
    // so both backups must survive.
    faults.locked = { operation: "rename", path: join(userData, "asset-state.v1.json") };
    await expect(sync.sync(root)).rejects.toMatchObject({ code: "EPERM" });
    faults.locked = null;
    expect(await readFile(join(root, "first.pack"), "utf8")).toBe("vanilla first");
    expect(await readFile(join(root, "second.pack"), "utf8")).toBe("vanilla second");
    expect((await sync.readState())?.packVersion).toBe("1.0.0");
    expect(await readFile(join(backups, "first.pack"), "utf8")).toBe("vanilla first");
    expect(await readFile(join(backups, "second.pack"), "utf8")).toBe("vanilla second");

    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "2.0.0" });
    expect(await readFile(join(root, "first.pack"), "utf8")).toBe("vanilla first");
    expect(await readFile(join(root, "second.pack"), "utf8")).toBe("vanilla second");
    expect((await sync.readState())?.assets).toEqual([]);
    expect(await readdir(backups)).toEqual([]);
  });

  it("a normal removal deletes only the backups of the files it restored", async () => {
    const { userData, root } = await setup();
    await writeFile(join(root, "kept.pack"), "vanilla kept");
    await writeFile(join(root, "dropped.pack"), "vanilla dropped");
    const kept = Buffer.from("custom kept");
    const dropped = Buffer.from("custom dropped");
    const feedV1 = manifest([
      assetEntry("kept", kept, { installPath: "kept.pack" }),
      assetEntry("dropped", dropped, { installPath: "dropped.pack" }),
    ]);
    await service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(feedV1)),
      [feedV1.assets[0].url]: () => new Response(kept),
      [feedV1.assets[1].url]: () => new Response(dropped),
    }).sync(root);

    const sync = service(userData, {
      [FEED_URL]: () => new Response(JSON.stringify(manifest([feedV1.assets[0]], "2.0.0"))),
    });
    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "2.0.0" });
    expect(await readFile(join(root, "dropped.pack"), "utf8")).toBe("vanilla dropped");
    expect(await readFile(join(root, "kept.pack"), "utf8")).toBe("custom kept");
    expect(await readdir(join(assetStorage(root), "asset-backups"))).toEqual(["kept.pack"]);

    await sync.restore(root);
    expect(await readFile(join(root, "kept.pack"), "utf8")).toBe("vanilla kept");
    expect(await sync.readState()).toBeNull();
    await expect(stat(join(assetStorage(root), "asset-backups"))).rejects.toThrow();
  });

  it("drops a backup left in the old userData folder once the state without it is written", async () => {
    const { userData, root } = await setup();
    await writeFile(join(root, "sounds.pack"), "custom sounds");
    await mkdir(join(userData, "asset-backups"), { recursive: true });
    await writeFile(join(userData, "asset-backups", "sounds.pack"), "vanilla sounds");
    await writeFile(join(userData, "asset-state.v1.json"), JSON.stringify({
      schemaVersion: 1, packVersion: "0.9.0", syncedAt: "2026-09-01T00:00:00Z",
      assets: [{
        name: "rotk-sounds", version: "0.9.0", sha256: sha256("custom sounds"),
        installedFiles: [{ path: "sounds.pack", sha256: sha256("custom sounds"), size: 13 }],
      }],
    }));

    // The old backup cannot be moved next to the install, so it is restored in place.
    faults.locked = { operation: "rename", path: join(assetStorage(root), "asset-backups", "sounds.pack") };
    const sync = service(userData, { [FEED_URL]: () => new Response(JSON.stringify(manifest([]))) });
    expect(await sync.sync(root)).toEqual({ status: "updated", packVersion: "1.0.0" });
    expect(await readFile(join(root, "sounds.pack"), "utf8")).toBe("vanilla sounds");
    expect((await sync.readState())?.assets).toEqual([]);
    await expect(stat(join(userData, "asset-backups", "sounds.pack"))).rejects.toThrow();
  });
});
