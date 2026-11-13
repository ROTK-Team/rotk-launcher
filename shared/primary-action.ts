import type { LauncherSnapshot } from "./contracts.js";
import { launcherUpdateBlocksPlay } from "./launcher-update.js";

/** H1Z1 is being started or is running. Every control that locks on it asks here. */
export function gameSessionActive(snapshot: LauncherSnapshot): boolean {
  return snapshot.gamePid !== null || snapshot.phase === "launching" || snapshot.phase === "running";
}

/** Asset packs are being checked, downloaded or installed. */
export function assetSyncActive(snapshot: LauncherSnapshot): boolean {
  const status = snapshot.assetSync.status;
  return status === "checking" || status === "downloading" || status === "installing";
}

export type PrimaryActionKind =
  /** A client install or adoption is running. */
  | "installing"
  /** The game runs; the button offers to close it. */
  | "stop-game"
  /** Assets, file check, ticket: the game is not started yet. */
  | "launching"
  /** A launcher update stands between the player and the game. */
  | "update"
  | "play"
  /** Installed, but no key for the selected server and role. */
  | "add-key"
  /** Everything is in place but the launcher is still finishing the last game's report. */
  | "wait"
  /** No usable installation: the button opens the setup panel. */
  | "setup";

export interface PrimaryAction {
  kind: PrimaryActionKind;
  enabled: boolean;
}

/**
 * What the main button is and whether it can be clicked, decided in one place.
 * The label, the click handler and the status line all follow this, so they
 * can no longer disagree (IN GAME while launching, INSTALL on a ready client).
 * `busy` is the renderer waiting for an answer to its own last request.
 */
export function primaryAction(snapshot: LauncherSnapshot, busy: boolean): PrimaryAction {
  if (snapshot.phase === "installing") return { kind: "installing", enabled: false };
  if (snapshot.phase === "running") return { kind: "stop-game", enabled: !busy };
  if (snapshot.phase === "launching") return { kind: "launching", enabled: false };
  if (snapshot.updateRequired || launcherUpdateBlocksPlay(snapshot.launcherUpdate)) {
    return { kind: "update", enabled: !busy };
  }
  if (snapshot.canPlay) return { kind: "play", enabled: !busy };
  if (snapshot.phase === "ready" && snapshot.installationRoot !== null) {
    if (!snapshot.playerIdentity.configured) return { kind: "add-key", enabled: !busy };
    // Installed and keyed, yet the main process refuses Play: it is finishing
    // a report. Sending the player to the setup panel would be wrong.
    return { kind: "wait", enabled: false };
  }
  return { kind: "setup", enabled: !busy };
}
