import type { LauncherPhase } from "../../shared/contracts.js";

export interface QuitState {
  /** The player closed the window while something below still had to finish. */
  windowClosedByPlayer: boolean;
  windowOpen: boolean;
  gameRunning: boolean;
  phase: LauncherPhase;
  /** A report is being finalized or sent, or a Debug setting is being saved. */
  diagnosticWork: boolean;
}

/**
 * What a launcher without a window still has to wait for: a game it started or
 * is starting, and the report of the last one. Closing the window during
 * anything else quits at once, as before.
 */
export function keepsLauncherAlive(state: Pick<QuitState, "gameRunning" | "phase" | "diagnosticWork">): boolean {
  return state.gameRunning || state.phase === "launching" || state.phase === "running" || state.diagnosticWork;
}

/**
 * The one rule for quitting a launcher whose window the player closed. It used
 * to be written out at each place a game or a report could end, with
 * different conditions, and some endings had none: the process then stayed
 * alive with no window, holding the single-instance lock.
 */
export function mayQuitWithoutWindow(state: QuitState): boolean {
  return state.windowClosedByPlayer && !state.windowOpen && !keepsLauncherAlive(state);
}
