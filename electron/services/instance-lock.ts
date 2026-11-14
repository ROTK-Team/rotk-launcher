import { ELEVATION_RELAUNCH_ARGUMENT } from "./startup-elevation.js";

/** This process was started by another launcher process asking for administrator rights. */
export function isElevationRelaunch(argv: readonly string[]): boolean {
  return argv.includes(ELEVATION_RELAUNCH_ARGUMENT);
}

/** How long the administrator relaunch waits for the lock of the process that started it. */
export const LOCK_HANDOFF_WAIT_MS = 5_000;
const LOCK_HANDOFF_PAUSE_MS = 250;

export interface LockHandoff {
  /** Asks for the single-instance lock: true when this process now owns it. */
  request(): boolean;
  /** This process is the administrator relaunch of another launcher process. */
  relaunched: boolean;
  /** Blocks for the given time; nothing else runs in this process yet. */
  pause(milliseconds: number): void;
  now(): number;
}

/**
 * Takes the single-instance lock, waiting for it when this process is the
 * administrator relaunch.
 *
 * On Windows a start of the launcher is two processes: the one the shortcut
 * starts, which asks for administrator rights, and the administrator one it
 * relaunches. The first used to give the lock up before the Windows prompt, so
 * that the second could take it. A second click during the prompt then took
 * the free lock: the relaunch found it held and left without a word, and the
 * player faced a second prompt. The first process now keeps the lock until it
 * quits, and the relaunch waits the moment that takes instead of giving up at
 * its first try. Any other process asks once, as before.
 */
export function acquireLockAfterHandoff(handoff: LockHandoff): boolean {
  if (handoff.request()) return true;
  if (!handoff.relaunched) return false;
  const deadline = handoff.now() + LOCK_HANDOFF_WAIT_MS;
  while (handoff.now() < deadline) {
    handoff.pause(LOCK_HANDOFF_PAUSE_MS);
    if (handoff.request()) return true;
  }
  return false;
}
