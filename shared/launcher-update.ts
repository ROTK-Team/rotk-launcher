import type { LauncherUpdateSummary } from "./contracts.js";

/** A known launcher update must be installed before the next game launch. */
export function hasLauncherUpdate(update: LauncherUpdateSummary): boolean {
  return Boolean(update.availableVersion) && (
    update.status === "update-available" || update.status === "downloading"
    || update.status === "downloaded" || update.status === "error"
  );
}
