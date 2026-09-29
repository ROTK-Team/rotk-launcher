import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installClient } from "../electron/services/installer.js";
import { AssetSyncService } from "../electron/services/asset-sync.js";
import {
  BASE_MANIFEST_URL,
  loadBaseManifest,
  mergeExpectedFiles,
  readLauncherOverrides,
} from "../electron/services/base-manifest.js";
import { measureInstallation } from "../electron/services/integrity-attestation.js";
import { SUPPORTED_CLIENT_BUILDS } from "../electron/services/client-build.js";

// Whole install path against the real Steam client and the live asset feed:
// copy, asset download (cut then resumed), then the integrity measurement the
// server would check, computed locally from the signed base manifest.
// Downloads ~5 GB and copies ~17 GB, so it only runs on request:
//   ROTK_H1Z1_SOURCE="C:\...\H1Z1" ROTK_E2E_NETWORK=1 npx vitest run tests/e2e-real-client.test.ts
const source = process.env.ROTK_H1Z1_SOURCE;
const enabled = Boolean(source) && process.env.ROTK_E2E_NETWORK === "1";

describe.skipIf(!enabled)("real client end to end", () => {
  it("installs, syncs assets with a resume, attests clean and restores vanilla", async () => {
    const root = await mkdtemp(join(process.env.ROTK_INSTALL_TEST_PARENT ?? tmpdir(), "rotk-e2e-"));
    const userData = join(root, "userData");
    const destination = join(root, "Games", "ROTK");
    const patches = join(process.cwd(), "resources", "patches");
    const log = (line: string) => console.info(`[e2e] ${line}`);
    try {
      let started = Date.now();
      await installClient({
        sourceRoot: source!,
        destinationRoot: destination,
        shimPath: join(patches, "steam_api64.dll"),
        vivoxProxyPath: join(patches, "vivoxsdk_x64.dll"),
        vivoxRuntimePath: join(patches, "vivoxsdk_x64_v5.dll"),
        launcherVersion: "e2e",
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
      log(`install: ${((Date.now() - started) / 1000).toFixed(0)} s`);

      // Asset sync, cut after ~300 MB, then resumed.
      const ranges: string[] = [];
      const trackingFetch: typeof fetch = async (input, init) => {
        const range = new Headers(init?.headers).get("range");
        if (range) ranges.push(range);
        return fetch(input, init);
      };
      const cut = new AbortController();
      let downloaded = 0;
      const first = new AssetSyncService({
        userDataDirectory: userData,
        fetchImpl: trackingFetch,
        onProgress: (progress) => {
          downloaded = progress.completedBytes;
          if (progress.completedBytes > 300 * 1024 ** 2) cut.abort(new DOMException("cut", "AbortError"));
        },
      });
      await expect(first.sync(destination, { signal: cut.signal })).rejects.toBeTruthy();
      log(`assets cut at ${(downloaded / 1024 ** 2).toFixed(0)} MB`);

      started = Date.now();
      const sync = new AssetSyncService({ userDataDirectory: userData, fetchImpl: trackingFetch });
      const outcome = await sync.sync(destination);
      log(`assets: ${outcome.status} ${outcome.packVersion} in ${((Date.now() - started) / 1000).toFixed(0)} s, ranges ${ranges.join(", ")}`);
      expect(ranges.length).toBeGreaterThan(0);

      // Cache and backups sit next to the install, nothing in userData.
      const storage = join(dirname(destination), `.${basename(destination)}-assets`);
      expect((await readdir(join(storage, "asset-cache"))).length).toBeGreaterThan(0);
      await expect(stat(join(userData, "asset-cache"))).rejects.toBeTruthy();

      // What the server would compare: base manifest + installed assets + our DLLs.
      const build = SUPPORTED_CLIENT_BUILDS[0];
      const base = await loadBaseManifest({
        url: BASE_MANIFEST_URL,
        userDataDirectory: userData,
        expectedBuildId: build.fileVersion,
      }).catch(async () => loadBaseManifest({
        url: BASE_MANIFEST_URL,
        userDataDirectory: userData,
        expectedBuildId: build.id,
      }));
      const overrides = await readLauncherOverrides([
        { installPath: "steam_api64.dll", bundledPath: join(patches, "steam_api64.dll") },
        { installPath: "vivoxsdk_x64.dll", bundledPath: join(patches, "vivoxsdk_x64.dll") },
        { installPath: "vivoxsdk_x64_v5.dll", bundledPath: join(patches, "vivoxsdk_x64_v5.dll") },
      ]);
      const state = await sync.readState();
      const installedAssets = (state?.assets ?? []).flatMap((asset) => asset.installedFiles);
      const measurement = await measureInstallation({
        installationRoot: destination,
        userDataDirectory: userData,
        expected: mergeExpectedFiles(base.files, installedAssets, overrides),
        detectUnexpected: true,
      });
      log(`attestation: ${measurement.fileCount} files, deviations ${JSON.stringify(measurement.deviations.slice(0, 5))}`);
      expect(measurement.deviations).toEqual([]);

      // Restore vanilla: back to the base tree with our DLLs.
      await sync.restore(destination);
      const vanilla = await measureInstallation({
        installationRoot: destination,
        userDataDirectory: userData,
        expected: mergeExpectedFiles(base.files, [], overrides),
        detectUnexpected: true,
      });
      log(`after restore: deviations ${JSON.stringify(vanilla.deviations.slice(0, 5))}`);
      expect(vanilla.deviations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90 * 60_000);
});
