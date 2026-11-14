import type { LauncherUpdateSummary } from "../../shared/contracts.js";
import { hasLauncherUpdate } from "../../shared/launcher-update.js";

export interface UpdateInfoLike {
  version: string;
}

export interface DownloadProgressLike {
  percent: number;
}

// The subset of electron-updater's AppUpdater the launcher relies on, kept
// injectable so the state machine can be unit-tested without Electron.
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: "update-available", listener: (info: UpdateInfoLike) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "download-progress", listener: (progress: DownloadProgressLike) => void): unknown;
  on(event: "update-downloaded", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface LauncherUpdateOptions {
  updater: UpdaterLike | null;
  onChange: (state: LauncherUpdateSummary) => void;
  /** Short failure code for logs; the raw message may carry signed URLs. */
  onDownloadError?: (code: string) => void;
}

const IDLE_STATE: LauncherUpdateSummary = {
  status: "idle",
  availableVersion: null,
  progressPercent: null,
  error: null,
};

export type LauncherUpdateFailure = "unavailable" | "not-downloaded" | "no-update";

/** A download with no progress for this long is reported as failed. */
export const DOWNLOAD_STALL_MS = 60_000;

export class LauncherUpdateService {
  private readonly updater: UpdaterLike | null;
  private readonly onChange: (state: LauncherUpdateSummary) => void;
  private readonly onDownloadError: (code: string) => void;
  private current: LauncherUpdateSummary = { ...IDLE_STATE };
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LauncherUpdateOptions) {
    this.updater = options.updater;
    this.onChange = options.onChange;
    this.onDownloadError = options.onDownloadError ?? (() => undefined);
    if (!this.updater) return;

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;

    this.updater.on("update-available", (info) => {
      this.transition({
        status: "update-available",
        availableVersion: typeof info.version === "string" ? info.version : null,
        progressPercent: null,
        error: null,
      });
    });
    this.updater.on("update-not-available", () => {
      this.transition({ ...IDLE_STATE, status: "up-to-date" });
    });
    this.updater.on("download-progress", (progress) => {
      if (this.current.status !== "downloading") return;
      this.watchForStall();
      this.transition({
        ...this.current,
        progressPercent: clampPercent(progress.percent),
      });
    });
    this.updater.on("update-downloaded", () => {
      this.transition({
        ...this.current,
        status: "downloaded",
        progressPercent: 100,
        error: null,
      });
    });
    this.updater.on("error", (error) => {
      // A failed check must never disturb the user: the launcher keeps
      // working offline. A failed download was user-initiated and deserves
      // a visible, retryable error.
      if (this.current.status === "downloading") {
        this.transition({
          ...this.current,
          status: "error",
          progressPercent: null,
          error: error.message,
        });
        this.onDownloadError(updateErrorCode(error));
      } else if (this.current.status === "checking") {
        this.transition({ ...IDLE_STATE });
      }
    });
  }

  get state(): LauncherUpdateSummary {
    return { ...this.current };
  }

  async check(): Promise<void> {
    if (!this.updater) return;
    if (
      this.current.status === "checking"
      || hasLauncherUpdate(this.current)
    ) {
      return;
    }
    this.transition({ ...IDLE_STATE, status: "checking" });
    try {
      await this.updater.checkForUpdates();
    } catch {
      this.resetIfChecking();
    }
  }

  private resetIfChecking(): void {
    if (this.current.status === "checking") this.transition({ ...IDLE_STATE });
  }

  download(): LauncherUpdateFailure | null {
    if (!this.updater) return "unavailable";
    if (this.current.status === "downloading" || this.current.status === "downloaded") return null;
    if (this.current.status !== "update-available" && this.current.status !== "error") {
      return "no-update";
    }
    if (!this.current.availableVersion) return "no-update";
    this.transition({
      ...this.current,
      status: "downloading",
      progressPercent: 0,
      error: null,
    });
    this.watchForStall();
    this.updater.downloadUpdate().catch(() => {
      // The terminal state is reported through the "error" event; this catch
      // only prevents an unhandled rejection when the download fails.
    });
    return null;
  }

  install(): LauncherUpdateFailure | null {
    if (!this.updater) return "unavailable";
    if (this.current.status !== "downloaded") return "not-downloaded";
    this.updater.quitAndInstall();
    return null;
  }

  /**
   * The updater has no timeout of its own under Electron: a download that
   * stops receiving data stayed on "downloading N%" for good, with no button
   * left. Without progress for a while it becomes a failed download, which
   * offers Retry. Data that arrives afterwards still completes it.
   */
  private watchForStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.current.status !== "downloading") return;
      this.transition({
        ...this.current,
        status: "error",
        progressPercent: null,
        error: "The download stopped receiving data.",
      });
      this.onDownloadError("stalled");
    }, DOWNLOAD_STALL_MS);
    this.stallTimer.unref?.();
  }

  private transition(next: LauncherUpdateSummary): void {
    if (next.status !== "downloading" && this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.current = next;
    this.onChange(this.state);
  }
}

function updateErrorCode(error: Error): string {
  const { code, statusCode } = error as Error & { code?: unknown; statusCode?: unknown };
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  if (typeof statusCode === "number") return `HTTP ${statusCode}`;
  return /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "Error";
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
