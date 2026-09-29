import type { LauncherUpdateSummary } from "./contracts.js";

/**
 * A known launcher update must be installed before the next game launch. A
 * failed download does not count: it would lock Play with no way out. The next
 * check finds the update again and asks for it.
 */
export function hasLauncherUpdate(update: LauncherUpdateSummary): boolean {
  return Boolean(update.availableVersion) && (
    update.status === "update-available" || update.status === "downloading"
    || update.status === "downloaded"
  );
}
