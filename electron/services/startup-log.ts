/**
 * Startup breadcrumbs for the launcher's main process.
 *
 * Until its window is on screen the launcher cannot say what it is doing: the
 * diagnostics service is built late in initialize(), and a Chromium abort
 * leaves only a Windows Error Reporting entry. Launcher 2.0.14 died exactly
 * there (issue #59): its requireAdministrator manifest applied to the GPU and
 * renderer children Chromium spawns from the same executable, sessions of the
 * built-in Administrator account could not create them, and Chromium ended
 * the process with "GPU process isn't usable. Goodbye." — nothing on disk said
 * which step had been reached. This log answers that question after the fact:
 * one line per step, written synchronously so a hard abort right after a step
 * still leaves its line.
 *
 * Writes never throw. A launcher that cannot write its breadcrumbs must still
 * start.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STARTUP_LOG_NAME = "startup.log";
export const PREVIOUS_STARTUP_LOG_NAME = "startup.previous.log";

export class StartupLog {
  private readonly directory: string;
  private readonly path: string;
  private readonly previousPath: string;
  private readonly now: () => Date;

  constructor(directory: string, now: () => Date = () => new Date()) {
    this.directory = directory;
    this.path = join(directory, STARTUP_LOG_NAME);
    this.previousPath = join(directory, PREVIOUS_STARTUP_LOG_NAME);
    this.now = now;
  }

  /**
   * Opens this run's log. The previous run's lines move to
   * startup.previous.log so a player whose launcher died can still hand over
   * the run that failed after a successful restart.
   *
   * With `continued`, the header is added to the log that is already open:
   * one start of the launcher is two processes on Windows, the one the
   * shortcut starts and the administrator one it relaunches. When both opened
   * a log of their own, startup.previous.log only ever held the few lines of
   * the first process, and the run that had failed before was gone.
   */
  begin(header: string, continued = false): void {
    if (continued) {
      this.mark(header);
      return;
    }
    try {
      mkdirSync(this.directory, { recursive: true });
      rmSync(this.previousPath, { force: true });
      try {
        renameSync(this.path, this.previousPath);
      } catch {
        // First run, or the previous log is unreadable: start fresh either way.
      }
      writeFileSync(this.path, this.line(header));
    } catch {
      // Never fail startup over a log file.
    }
  }

  mark(step: string, detail?: string): void {
    try {
      appendFileSync(this.path, this.line(detail === undefined ? step : `${step} ${detail}`));
    } catch {
      // Never fail startup over a log file.
    }
  }

  private line(text: string): string {
    // One breadcrumb per line: a multi-line detail would read as several steps.
    return `${this.now().toISOString()} ${text.replace(/\r?\n/g, " ")}\n`;
  }
}
