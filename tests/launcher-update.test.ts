import { describe, expect, it, vi } from "vitest";
import type { LauncherUpdateSummary } from "../shared/contracts.js";
import { hasLauncherUpdate, launcherUpdateBlocksPlay } from "../shared/launcher-update.js";
import {
  LauncherUpdateService,
  type DownloadProgressLike,
  type UpdateInfoLike,
  type UpdaterLike,
} from "../electron/services/launcher-update.js";

type Listeners = {
  "update-available": Array<(info: UpdateInfoLike) => void>;
  "update-not-available": Array<() => void>;
  "download-progress": Array<(progress: DownloadProgressLike) => void>;
  "update-downloaded": Array<() => void>;
  error: Array<(error: Error) => void>;
};

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => null);
  quitAndInstall = vi.fn();
  private readonly listeners: Listeners = {
    "update-available": [],
    "update-not-available": [],
    "download-progress": [],
    "update-downloaded": [],
    error: [],
  };

  on(event: keyof Listeners, listener: (...args: never[]) => void): this {
    this.listeners[event].push(listener as never);
    return this;
  }

  emit<E extends keyof Listeners>(event: E, ...args: Parameters<Listeners[E][number]>): void {
    for (const listener of this.listeners[event]) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

function createService(): {
  updater: FakeUpdater;
  service: LauncherUpdateService;
  states: LauncherUpdateSummary[];
} {
  const updater = new FakeUpdater();
  const states: LauncherUpdateSummary[] = [];
  const service = new LauncherUpdateService({
    updater,
    onChange: (state) => states.push(state),
  });
  return { updater, service, states };
}

describe("launcher self-update service", () => {
  it("hardens the injected updater for user-driven updates only", () => {
    const { updater } = createService();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("stays inert without an updater (development build)", async () => {
    const states: LauncherUpdateSummary[] = [];
    const service = new LauncherUpdateService({
      updater: null,
      onChange: (state) => states.push(state),
    });
    await service.check();
    expect(service.download()).toBe("unavailable");
    expect(service.install()).toBe("unavailable");
    expect(service.state.status).toBe("idle");
    expect(states).toEqual([]);
  });

  it("walks the full state machine from check to downloaded", async () => {
    const { updater, service, states } = createService();
    await service.check();
    updater.emit("update-available", { version: "0.3.0" });
    expect(service.state).toMatchObject({ status: "update-available", availableVersion: "0.3.0" });

    expect(service.download()).toBeNull();
    updater.emit("download-progress", { percent: 42.4 });
    expect(service.state).toMatchObject({ status: "downloading", progressPercent: 42 });

    updater.emit("update-downloaded");
    expect(service.state).toMatchObject({ status: "downloaded", progressPercent: 100 });
    expect(states.map((state) => state.status)).toEqual([
      "checking",
      "update-available",
      "downloading",
      "downloading",
      "downloaded",
    ]);
  });

  it("reports up-to-date when no newer release exists", async () => {
    const { updater, service } = createService();
    await service.check();
    updater.emit("update-not-available");
    expect(service.state.status).toBe("up-to-date");
  });

  it("silently returns to idle when a check fails", async () => {
    const { updater, service } = createService();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    await service.check();
    expect(service.state).toMatchObject({ status: "idle", error: null });

    await service.check();
    updater.emit("error", new Error("HTTP 500"));
    expect(service.state).toMatchObject({ status: "idle", error: null });
  });

  it("never downloads without a known available update", () => {
    const { updater, service } = createService();
    expect(service.download()).toBe("no-update");
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("surfaces a retryable error when the download fails", async () => {
    const { updater, service } = createService();
    await service.check();
    updater.emit("update-available", { version: "0.3.0" });
    service.download();
    updater.emit("error", new Error("connection reset"));
    expect(service.state).toMatchObject({
      status: "error",
      availableVersion: "0.3.0",
      error: "connection reset",
    });

    expect(service.download()).toBeNull();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it("refuses to install before the update is downloaded", async () => {
    const { updater, service } = createService();
    await service.check();
    updater.emit("update-available", { version: "0.3.0" });
    expect(service.install()).toBe("not-downloaded");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    service.download();
    updater.emit("update-downloaded");
    expect(service.install()).toBeNull();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("ignores stray progress events outside a download", async () => {
    const { updater, service } = createService();
    await service.check();
    updater.emit("update-available", { version: "0.3.0" });
    updater.emit("download-progress", { percent: 50 });
    expect(service.state).toMatchObject({ status: "update-available", progressPercent: null });
  });

  it("keeps a known update across timer checks and download failures without locking Play", async () => {
    const { updater, service } = createService();
    await service.check();
    updater.emit("update-available", { version: "2.0.24" });
    expect(hasLauncherUpdate(service.state)).toBe(true);
    updater.checkForUpdates.mockRejectedValue(new Error("offline"));
    await service.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(service.state.status).toBe("update-available");
    service.download();
    expect(hasLauncherUpdate(service.state)).toBe(true);
    expect(launcherUpdateBlocksPlay(service.state)).toBe(true);
    updater.emit("error", new Error("offline"));
    await service.check();
    expect(service.state).toMatchObject({ status: "error", availableVersion: "2.0.24" });
    // The banner keeps the error and Retry, but a failed download must not lock Play.
    expect(hasLauncherUpdate(service.state)).toBe(true);
    expect(launcherUpdateBlocksPlay(service.state)).toBe(false);
    service.download();
    updater.emit("update-downloaded");
    expect(launcherUpdateBlocksPlay(service.state)).toBe(true);
  });

  it("reports a short code, never the raw updater message, for a failed download", async () => {
    const updater = new FakeUpdater();
    const codes: string[] = [];
    const service = new LauncherUpdateService({ updater, onChange: () => undefined, onDownloadError: (code) => codes.push(code) });
    await service.check();
    updater.emit("update-available", { version: "2.0.24" });
    service.download();
    const failure = Object.assign(new Error("Cannot download https://x.example/a?X-Amz-Signature=secret"), { statusCode: 403 });
    updater.emit("error", failure);
    service.download();
    updater.emit("error", Object.assign(new Error("sha512 mismatch"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }));
    expect(codes).toEqual(["HTTP 403", "ERR_UPDATER_INVALID_SIGNATURE"]);
  });

  it("does not block launch just because the initial update check is offline", async () => {
    const { updater, service } = createService();
    updater.checkForUpdates.mockRejectedValue(new Error("offline"));
    await service.check();
    expect(hasLauncherUpdate(service.state)).toBe(false);
  });
});
