import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_PREFETCH_INTERVAL_MS as INTERVAL,
  AssetPrefetchScheduler,
  canPrefetchAssets,
} from "../electron/services/asset-prefetch.js";

describe("background asset download", () => {
  const schedulers: AssetPrefetchScheduler[] = [];

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose();
    vi.useRealTimers();
  });

  function scheduler(
    run: (signal: AbortSignal) => Promise<void>,
    options: { canStart?: () => boolean; onFailure?: (error: unknown, failuresInARow: number) => void } = {},
  ): AssetPrefetchScheduler {
    const created = new AssetPrefetchScheduler({
      canStart: options.canStart ?? (() => true),
      run,
      onFailure: options.onFailure ?? (() => undefined),
    });
    schedulers.push(created);
    return created;
  }

  it("only runs on a ready launcher with the sync on and nothing else going on", () => {
    const ready = { enabled: true, phase: "ready", busy: false, gameRunning: false } as const;
    expect(canPrefetchAssets(ready)).toBe(true);
    expect(canPrefetchAssets({ ...ready, enabled: false })).toBe(false);
    expect(canPrefetchAssets({ ...ready, busy: true })).toBe(false);
    expect(canPrefetchAssets({ ...ready, gameRunning: true })).toBe(false);
    for (const phase of ["unconfigured", "installing", "launching", "running", "error"] as const) {
      expect(canPrefetchAssets({ ...ready, phase })).toBe(false);
    }
  });

  it("checks at start-up, then once per interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    scheduler(run).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never runs with the sync off, and checks as soon as it is turned back on", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const run = vi.fn(async () => undefined);
    const prefetch = scheduler(run, {
      canStart: () => canPrefetchAssets({ enabled, phase: "ready", busy: false, gameRunning: false }),
    });
    prefetch.start();
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(run).not.toHaveBeenCalled();

    enabled = true;
    prefetch.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("only reports failures and waits longer after each one", async () => {
    vi.useFakeTimers();
    let online = false;
    const run = vi.fn(async () => {
      if (!online) throw new Error("Le flux d’assets ROTK est indisponible. Vérifie ta connexion puis réessaie.");
    });
    const onFailure = vi.fn();
    scheduler(run, { onFailure }).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenLastCalledWith(expect.any(Error), 1);

    // 1 h, 2 h, then at most every 4 h.
    for (const [wait, failures] of [[2, 2], [4, 3], [8, 4], [8, 5]] as const) {
      await vi.advanceTimersByTimeAsync(wait * INTERVAL - 1);
      expect(run).toHaveBeenCalledTimes(failures - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(failures);
      expect(onFailure).toHaveBeenLastCalledWith(expect.any(Error), failures);
    }

    // Back online: one more check after 4 h, then the normal interval again.
    online = true;
    await vi.advanceTimersByTimeAsync(8 * INTERVAL);
    expect(run).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(7);
    expect(onFailure).toHaveBeenCalledTimes(5);
  });

  it("interrupt() aborts the download and returns once it has stopped", async () => {
    vi.useFakeTimers();
    let stopped = false;
    const run = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        // The download needs a moment to close its file.
        setTimeout(() => {
          stopped = true;
          reject(new DOMException("This operation was aborted", "AbortError"));
        }, 50);
      }, { once: true });
    }));
    const onFailure = vi.fn();
    const prefetch = scheduler(run, { onFailure });
    prefetch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    // A check requested meanwhile does not start a second download.
    prefetch.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    let interrupted = false;
    const interrupt = prefetch.interrupt().then(() => { interrupted = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await interrupt;
    expect(stopped).toBe(true);
    // Not a failure: the next check comes after the normal interval.
    expect(onFailure).not.toHaveBeenCalled();
    run.mockImplementation(async () => undefined);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("dispose() aborts the download and stops checking", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
      });
    });
    const prefetch = scheduler(run);
    prefetch.start();
    await vi.advanceTimersByTimeAsync(0);
    prefetch.dispose();
    expect(signals[0].aborted).toBe(true);
    prefetch.poke();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is stopped before a sync or an installation uses the asset cache", async () => {
    const main = await readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
    const sync = main.slice(main.indexOf("async function runAssetSync("));
    expect(sync.indexOf("await stopAssetPrefetch();")).toBeGreaterThan(0);
    expect(sync.indexOf("await stopAssetPrefetch();")).toBeLessThan(sync.indexOf("await assetSync.sync(root)"));
    const install = main.slice(main.indexOf("IPC_CHANNELS.install,"));
    expect(install.indexOf("await stopAssetPrefetch();")).toBeGreaterThan(0);
    expect(install.indexOf("await stopAssetPrefetch();")).toBeLessThan(install.indexOf("await adoptExistingClient("));
  });

  it("is stopped when the automatic sync is turned off", async () => {
    const main = await readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
    const setting = main.slice(main.indexOf("IPC_CHANNELS.setAssetSyncEnabled,"));
    const handler = setting.slice(0, setting.indexOf("ipcMain.handle("));
    expect(handler).toMatch(/if \(enabled\) assetPrefetch\.poke\(\);\s*else await stopAssetPrefetch\(\);/);
  });
});
