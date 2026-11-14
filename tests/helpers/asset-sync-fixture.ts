import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssetManifest, AssetManifestEntry } from "../../electron/services/asset-sync.js";

export const FEED_URL = "https://raw.githubusercontent.com/rotk/rotk-assets/main/feed.json";
export const INSTALL_MARKER_NAME = ".rotk-installation.json";

/** Where the launcher keeps cache and backups for an install root. */
export function assetStorage(root: string): string {
  return join(dirname(root), `.${basename(root)}-assets`);
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assetEntry(
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

export function manifest(assets: AssetManifestEntry[], packVersion = "1.0.0"): AssetManifest {
  return { manifestVersion: 1, packVersion, assets };
}

export type Route = () => Response | Promise<Response>;

/** A fetch that only knows the given URLs and records every call. */
export function routedFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const handler = routes[url];
    if (!handler) throw new TypeError("fetch failed");
    return handler();
  }) as typeof fetch;
}

const created: string[] = [];

/** A user data folder and an installed client folder, removed by `removeFixtures`. */
export async function installedClient(marker = "{}\n"): Promise<{ userData: string; root: string }> {
  const userData = await mkdtemp(join(tmpdir(), "rotk-asset-userdata-"));
  const root = await mkdtemp(join(tmpdir(), "rotk-asset-client-"));
  created.push(userData, root, assetStorage(root));
  await writeFile(join(root, INSTALL_MARKER_NAME), marker);
  return { userData, root };
}

export async function removeFixtures(): Promise<void> {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}
