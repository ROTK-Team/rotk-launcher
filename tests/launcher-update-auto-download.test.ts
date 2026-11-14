import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../electron/services/config-store.js";
import { LauncherUpdateService, type UpdaterLike } from "../electron/services/launcher-update.js";

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => null);
  quitAndInstall = vi.fn();
  private readonly listeners = new Map<string, Array<(...values: unknown[]) => void>>();

  on(event: string, listener: (...values: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener as (...values: unknown[]) => void]);
    return this;
  }

  emit(event: string, ...values: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...values);
  }
}

function createService(allowed: { value: boolean }) {
  const updater = new FakeUpdater();
  const codes: string[] = [];
  const service = new LauncherUpdateService({
    updater,
    onChange: () => undefined,
    onDownloadError: (code) => codes.push(code),
    autoDownload: () => allowed.value,
  });
  return { updater, service, codes };
}

describe("launcher update downloaded without a click", () => {
  it("starts the download as soon as the update is found", async () => {
    const { updater, service } = createService({ value: true });
    await service.check();
    updater.emit("update-available", { version: "2.0.51" });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(service.state.status).toBe("downloading");

    updater.emit("update-downloaded");
    expect(service.state.status).toBe("downloaded");
  });

  it("only offers the update when the setting is off, as before", async () => {
    const { updater, service } = createService({ value: false });
    await service.check();
    updater.emit("update-available", { version: "2.0.51" });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(service.state.status).toBe("update-available");
  });

  it("downloads at the next check an update found while it was not allowed (a game was running)", async () => {
    const allowed = { value: false };
    const { updater, service } = createService(allowed);
    await service.check();
    updater.emit("update-available", { version: "2.0.51" });

    allowed.value = true;
    await service.check();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    // The update is known: no second request for the release metadata.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("fails quietly, offers the update again and retries at the next check", async () => {
    const { updater, service, codes } = createService({ value: true });
    await service.check();
    updater.emit("update-available", { version: "2.0.51" });
    updater.emit("error", Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
    expect(service.state).toMatchObject({ status: "update-available", availableVersion: "2.0.51", error: null });
    expect(codes).toEqual(["ECONNRESET"]);

    await service.check();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it("shows the error when the player clicked on a download that then fails", async () => {
    const allowed = { value: true };
    const { updater, service } = createService(allowed);
    await service.check();
    updater.emit("update-available", { version: "2.0.51" });
    // The banner's button, pressed while the launcher's own download runs.
    expect(service.download()).toBeNull();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    updater.emit("error", new Error("connection reset"));
    expect(service.state).toMatchObject({ status: "error", error: "connection reset" });
  });

  it("remembers the player's choice across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rotk-update-setting-"));
    try {
      expect((await new ConfigStore(directory).load()).launcherUpdateAutoDownload).toBeUndefined();
      await new ConfigStore(directory).setLauncherUpdateAutoDownload(false);
      expect((await new ConfigStore(directory).load()).launcherUpdateAutoDownload).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
