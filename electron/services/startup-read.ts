/** How long the launcher waits at startup for a file another program holds. */
export const STARTUP_READ_WAIT_MS = 30_000;
const STARTUP_READ_PAUSE_MS = 1_000;

const HELD_BY_ANOTHER_PROGRAM = new Set(["EBUSY", "EPERM", "EACCES"]);

export interface StartupReadOptions {
  /** Called once, when the first read found the file held. */
  onWait?(code: string): void;
  waitMs?: number;
  pause?(milliseconds: number): Promise<void>;
  now?(): number;
}

/**
 * Reads one of the files the launcher cannot start without, waiting for it
 * when an antivirus, a backup or a sync tool holds it.
 *
 * The stores retry for 1.5 to 7.5 s, then throw: at startup that closed the
 * launcher with an error box, for a file that is often free a few seconds
 * later. The window is already on screen at that point, so the read is simply
 * tried again for a while longer. Any other error, and a file still held at
 * the end, is thrown as before.
 */
export async function readWhenFree<T>(read: () => Promise<T>, options: StartupReadOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.waitMs ?? STARTUP_READ_WAIT_MS);
  let waiting = false;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
      if (!HELD_BY_ANOTHER_PROGRAM.has(code) || now() >= deadline) throw error;
      if (!waiting) {
        waiting = true;
        options.onWait?.(code);
      }
      await pause(STARTUP_READ_PAUSE_MS);
    }
  }
}
