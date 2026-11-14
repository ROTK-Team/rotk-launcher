import type { LauncherUpdateSummary } from "./contracts.js";

/** A known launcher update: the banner and prompt offer it, with Retry after a failed download. */
export function hasLauncherUpdate(update: LauncherUpdateSummary): boolean {
  return Boolean(update.availableVersion) && (
    update.status === "update-available" || update.status === "downloading"
    || update.status === "downloaded" || update.status === "error"
  );
}

/**
 * Whether a known launcher update keeps the player from launching: it never
 * does. Every published release used to block Play as soon as the launcher
 * had seen it, at startup or in the middle of a session, required or not. The
 * banner still offers the update; only the server decides that a version is
 * too old, and its refusal (`updateRequired`) is what blocks Play.
 *
 * Kept as a function so its callers read the rule from one place.
 */
export function launcherUpdateBlocksPlay(_update: LauncherUpdateSummary): boolean {
  return false;
}
