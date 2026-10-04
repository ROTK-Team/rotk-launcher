import type { LauncherUpdateSummary } from "./contracts.js";

/** A known launcher update: the banner and prompt offer it, with Retry after a failed download. */
export function hasLauncherUpdate(update: LauncherUpdateSummary): boolean {
  return Boolean(update.availableVersion) && (
    update.status === "update-available" || update.status === "downloading"
    || update.status === "downloaded" || update.status === "error"
  );
}

/**
 * A known launcher update must be installed before the next game launch. A
 * failed download does not lock Play: it would leave the player with no way out.
 */
export function launcherUpdateBlocksPlay(update: LauncherUpdateSummary): boolean {
  return hasLauncherUpdate(update) && update.status !== "error";
}
