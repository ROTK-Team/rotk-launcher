import { Transform } from "node:stream";

/** Waits shorter than a Windows timer tick are saved up instead of slept one by one. */
const SHORTEST_WAIT_MS = 15;
/** How far behind its schedule a download may catch up at once, after a late timer or a slow network. */
const CATCH_UP_MS = 250;

/**
 * Paces a download on a schedule: every chunk pushes back the time the next
 * one is due by what it is worth at the limit, and the stream only waits when
 * it is ahead of that time. Sleeping once per chunk, as this did, turned every
 * limit into about 1 MB/s: a timer cannot sleep the 3 ms a chunk is worth.
 * `bytesPerSecond` is read per chunk, so a limit changed in the settings
 * applies to the download under way; 0 or less means no limit.
 */
export function speedLimiter(bytesPerSecond: () => number): Transform {
  let due: number | null = null;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const limit = bytesPerSecond();
      if (!(limit > 0)) return callback(null, chunk);
      const now = performance.now();
      due = Math.max(due ?? now, now - CATCH_UP_MS) + (chunk.byteLength / limit) * 1000;
      if (due - now < SHORTEST_WAIT_MS) return callback(null, chunk);
      setTimeout(() => callback(null, chunk), due - now);
    },
  });
}
