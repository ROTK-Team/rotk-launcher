/** Reloads tried for failures that follow each other closely. */
export const WINDOW_RELOAD_ATTEMPTS = 2;
/** Failures older than this are forgotten: a launcher stays open for hours. */
export const WINDOW_FAILURE_MEMORY_MS = 60_000;

export type WindowRecovery = "ignore" | "reload" | "give-up";

/**
 * What to do when the launcher page is lost: its process ended (`reason` is
 * Electron's render-process-gone reason) or it could not be loaded
 * ("load-failed").
 *
 * The window has no frame, so a window without its page has no button left,
 * not even to close it. A crash is answered by loading the page again; when
 * that keeps failing, or when Windows refused to create the process at all
 * ("launch-failed": asking again asks for the same thing), the caller tells
 * the player and closes the window instead of leaving an empty rectangle.
 */
export function windowRecovery(reason: string, recentFailures: number): WindowRecovery {
  if (reason === "clean-exit") return "ignore";
  if (reason === "launch-failed") return "give-up";
  return recentFailures < WINDOW_RELOAD_ATTEMPTS ? "reload" : "give-up";
}
