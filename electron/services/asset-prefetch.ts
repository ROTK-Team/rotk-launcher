import type { LauncherPhase } from "../../shared/contracts.js";

/**
 * Downloads asset updates while the launcher waits, so pressing Play only has
 * to install them. The feed is checked at start-up and then every 30 minutes;
 * new payloads go to the asset cache (AssetSyncService.prefetch) and are never
 * installed here. Play, Verify files and an installation interrupt a download
 * in progress before their own sync, which resumes its `.part` file with a
 * Range request.
 */

export const ASSET_PREFETCH_INTERVAL_MS = 30 * 60 * 1_000;
/** Each failure in a row doubles the wait, up to this. */
const ASSET_PREFETCH_MAX_DELAY_MS = 4 * 60 * 60 * 1_000;

export interface AssetPrefetchConditions {
  /** The automatic asset update setting. */
  enabled: boolean;
  phase: LauncherPhase;
  /** A sync, Verify files or an installation is running. */
  busy: boolean;
  gameRunning: boolean;
}

/** Only a launcher that is ready and doing nothing else downloads in the background. */
export function canPrefetchAssets(conditions: AssetPrefetchConditions): boolean {
  return conditions.enabled
    && conditions.phase === "ready"
    && !conditions.busy
    && !conditions.gameRunning;
}

export interface AssetPrefetchSchedulerOptions {
  canStart(): boolean;
  run(signal: AbortSignal): Promise<void>;
  /** Background failures are only logged; the next try waits longer. */
  onFailure(error: unknown, failuresInARow: number): void;
  intervalMs?: number;
}

export class AssetPrefetchScheduler {
  private readonly options: AssetPrefetchSchedulerOptions;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private current: { controller: AbortController; done: Promise<void> } | null = null;
  private failures = 0;
  private disposed = false;

  constructor(options: AssetPrefetchSchedulerOptions) {
    this.options = options;
    this.intervalMs = options.intervalMs ?? ASSET_PREFETCH_INTERVAL_MS;
  }

  /** First check now, then one per interval. */
  start(): void {
    this.schedule(0);
  }

  /** Check now, for example when the setting is turned back on. */
  poke(): void {
    if (!this.current) this.schedule(0);
  }

  /**
   * Abort the download in progress and wait until it has stopped, so its
   * `.part` file is closed before a sync opens it.
   */
  async interrupt(): Promise<void> {
    const current = this.current;
    if (!current) return;
    current.controller.abort();
    await current.done;
  }

  /** On quit. The `.part` file stays for the next download to resume. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.current?.controller.abort();
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  private tick(): void {
    if (this.disposed || this.current) return;
    if (!this.options.canStart()) {
      this.schedule(this.intervalMs);
      return;
    }
    const controller = new AbortController();
    const done = this.runOnce(controller.signal).then((delayMs) => {
      this.current = null;
      this.schedule(delayMs);
    });
    this.current = { controller, done };
  }

  /** Never rejects; returns the wait before the next check. */
  private async runOnce(signal: AbortSignal): Promise<number> {
    try {
      await this.options.run(signal);
      this.failures = 0;
      return this.intervalMs;
    } catch (error) {
      // Interrupted by the sync that takes over, or by quitting: not a failure.
      if (signal.aborted) return this.intervalMs;
      this.failures += 1;
      try {
        this.options.onFailure(error, this.failures);
      } catch {
        // Logging must not stop the schedule.
      }
      return Math.min(this.intervalMs * 2 ** this.failures, ASSET_PREFETCH_MAX_DELAY_MS);
    }
  }
}
