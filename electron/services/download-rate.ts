import { performance } from "node:perf_hooks";

/** The speed shown is the average over this much download time. */
const WINDOW_MS = 10_000;
/** At most one sample per this interval: a fast link delivers thousands of chunks a second. */
const SAMPLE_INTERVAL_MS = 250;
/** Fewer samples than this give no speed at all. */
const MIN_SPEED_SPAN_MS = 2_000;
/** The time left waits for a steadier speed than the speed itself. */
const MIN_TIME_LEFT_SPAN_MS = 5_000;

export interface DownloadEstimate {
  bytesPerSecond?: number;
  secondsLeft?: number;
}

interface Sample {
  /** Download time, paused time left out. */
  at: number;
  /** Bytes received up to `at`. */
  bytes: number;
}

/**
 * Download speed measured on the bytes that actually come from the network,
 * not on the progress counter, which jumps for packs found in the cache and
 * for resumed `.part` files. The clock only runs between resume() and pause(),
 * so the SHA-256 check, the installation of a pack and the wait before a retry
 * neither lower the speed nor restart the measurement.
 */
export class DownloadRateMeter {
  private readonly samples: Sample[] = [];
  private received = 0;
  private pausedTotal = 0;
  private pausedAt: number | null;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.pausedAt = now();
  }

  resume(): void {
    if (this.pausedAt === null) return;
    this.pausedTotal += this.now() - this.pausedAt;
    this.pausedAt = null;
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  /** Count bytes just received from the network. */
  add(bytes: number): void {
    this.received += bytes;
    const at = this.downloadTime();
    // The newest sample follows the latest chunk until it is SAMPLE_INTERVAL_MS
    // past the one before it, so a stall really reads as zero.
    const newest = this.samples.at(-1);
    const previous = this.samples.at(-2);
    if (newest && previous && newest.at - previous.at < SAMPLE_INTERVAL_MS) {
      newest.at = at;
      newest.bytes = this.received;
    } else {
      this.samples.push({ at, bytes: this.received });
    }
    this.dropOldSamples(at);
  }

  /**
   * Speed over the last WINDOW_MS, and the time `remainingBytes` takes at
   * that speed. Each is left out while it is not known well enough, and both
   * while paused.
   */
  estimate(remainingBytes: number): DownloadEstimate {
    if (this.pausedAt !== null) return {};
    const at = this.downloadTime();
    this.dropOldSamples(at);
    const oldest = this.samples[0];
    if (!oldest) return {};
    const span = at - oldest.at;
    if (span < MIN_SPEED_SPAN_MS) return {};
    const bytesPerSecond = ((this.received - oldest.bytes) * 1_000) / span;
    if (span < MIN_TIME_LEFT_SPAN_MS || bytesPerSecond <= 0 || remainingBytes <= 0) {
      return { bytesPerSecond: Math.round(bytesPerSecond) };
    }
    return {
      bytesPerSecond: Math.round(bytesPerSecond),
      secondsLeft: Math.ceil(remainingBytes / bytesPerSecond),
    };
  }

  private downloadTime(): number {
    return (this.pausedAt ?? this.now()) - this.pausedTotal;
  }

  /** Keep a single sample from before the window: it is where the window starts. */
  private dropOldSamples(at: number): void {
    while (this.samples.length > 1 && this.samples[1].at <= at - WINDOW_MS) this.samples.shift();
  }
}
