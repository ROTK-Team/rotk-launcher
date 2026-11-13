import type { LauncherPhase } from "../../shared/contracts.js";

/**
 * The phase after the player picked a source or a destination folder.
 *
 * The pick is only a draft for the next install. It moves the setup forward
 * when there is nothing to play yet, and it must leave an installed client
 * alone: picking a folder in the settings of a ready launcher used to drop
 * "ready", so Play disappeared until a new install or a restart. The installed
 * client stays playable until another install actually completes.
 */
export function phaseAfterSelection(
  current: LauncherPhase,
  selected: "source-selected" | "destination-selected",
): LauncherPhase {
  if (current === "ready" || current === "installing" || current === "launching" || current === "running") return current;
  return selected;
}
