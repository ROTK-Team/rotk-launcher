/**
 * Restarting without the window's sandbox when Windows refuses it (issue #151).
 *
 * Since 2.0.25 the window only opens once the launcher runs as administrator.
 * On some PCs Windows then refuses to create the window's sandboxed process:
 * startup.log shows "render-process-gone launch-failed exitCode=18" (Chromium's
 * SBOX_ERROR_CREATE_PROCESS) and no window ever appears, on every restart.
 * Electron 43 cannot drop administrator rights for the window, so the player
 * is offered a restart without the sandbox. The choice only holds for the
 * launcher version that recorded it, so every update tries the sandbox again,
 * and while it holds the window gets nothing but the launcher's own files.
 *
 * Everything here is synchronous on purpose: the marker is read before
 * Electron's ready event, and written between a modal box and the relaunch.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SANDBOX_FALLBACK_MARKER_NAME = "sandbox-fallback.v1.json";
/** Chromium's SBOX_ERROR_CREATE_PROCESS: Windows refused to create the sandboxed process. */
export const SANDBOX_CREATE_PROCESS_EXIT_CODE = 18;
const MAX_MARKER_BYTES = 1024;
// Schemes served from the launcher's own files or from memory. Anything else
// reaching the window's session is network traffic.
const LOCAL_SCHEMES = new Set(["file:", "data:", "blob:", "devtools:"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export interface RendererFailure {
  reason: string;
  exitCode: number;
}

export interface SandboxFallbackContext {
  platform: NodeJS.Platform;
  /** Windows confirmed the launcher's token is elevated. */
  administrator: boolean;
  /** This process already runs without the sandbox. */
  fallbackActive: boolean;
  /** A window of this process finished loading once, so the sandbox works here. */
  windowLoaded: boolean;
}

/** Only the exact failure of #151, once, before the window ever worked. */
export function offersSandboxFallback(failure: RendererFailure, context: SandboxFallbackContext): boolean {
  return context.platform === "win32"
    && context.administrator
    && !context.fallbackActive
    && !context.windowLoaded
    && failure.reason === "launch-failed"
    && failure.exitCode === SANDBOX_CREATE_PROCESS_EXIT_CODE;
}

export type SandboxFallbackState = "active" | "absent" | "outdated" | "invalid";

/**
 * "active" only for a marker recorded by this exact launcher version. A marker
 * from another version or a damaged one is ignored and removed, so the player
 * is asked again if the window still cannot start. A marker that cannot be
 * read right now counts as absent and stays where it is.
 */
export function readSandboxFallback(directory: string, launcherVersion: string): SandboxFallbackState {
  const path = join(directory, SANDBOX_FALLBACK_MARKER_NAME);
  let state: SandboxFallbackState;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_MARKER_BYTES) {
      state = "invalid";
    } else {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      const recorded = typeof value === "object" && value !== null
        ? (value as { launcherVersion?: unknown }).launcherVersion
        : undefined;
      if (typeof recorded !== "string" || recorded.length === 0) state = "invalid";
      else state = recorded === launcherVersion ? "active" : "outdated";
    }
  } catch (error) {
    // Missing, or held by another program for a moment: an antivirus can lock
    // the marker right after it was written (EBUSY, EPERM, EACCES) during the
    // relaunch. Only a marker that was read and found wrong is removed.
    if (typeof (error as NodeJS.ErrnoException).code === "string") return "absent";
    state = "invalid";
  }
  if (state !== "active") {
    try {
      rmSync(path, { force: true });
    } catch {
      // Ignored either way: a marker that stays is read the same next time.
    }
  }
  return state;
}

/** Records the player's choice for this launcher version. Throws if it was not saved. */
export function recordSandboxFallback(directory: string, launcherVersion: string, now: Date = new Date()): void {
  const target = join(directory, SANDBOX_FALLBACK_MARKER_NAME);
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  const marker = { launcherVersion, acceptedAt: now.toISOString() };
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A leftover temporary file is never read.
    }
  }
}

/**
 * Whether a request of the window's session is cancelled while the sandbox is
 * off: everything but the launcher's own files (news images from rotk.app
 * included). `devServerUrl` is the Vite server of a development run only.
 */
export function cancelsRequestWithoutSandbox(url: string, devServerUrl: string | null = null): boolean {
  let request: URL;
  try {
    request = new URL(url);
  } catch {
    return true;
  }
  if (LOCAL_SCHEMES.has(request.protocol)) return false;
  if (devServerUrl && NETWORK_SCHEMES.has(request.protocol)) {
    try {
      if (request.host === new URL(devServerUrl).host) return false;
    } catch {
      // An unreadable development URL allows nothing.
    }
  }
  return true;
}
