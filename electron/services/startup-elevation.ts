import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const ELEVATION_RELAUNCH_ARGUMENT = "--rotk-elevation-relaunch";
type NativeCommand = "--admin-status" | "--elevate-launcher";
type NativeRunner = (helperPath: string, command: NativeCommand, timeoutMs: number) => Promise<string>;

async function runNativeHelper(helperPath: string, command: NativeCommand, timeoutMs: number): Promise<string> {
  // Match the bundled helper's signing-aware sidecar; refuse missing, linked,
  // oversized or damaged resources before running any native code.
  const [binaryInfo, sidecarInfo] = await Promise.all([lstat(helperPath), lstat(`${helperPath}.sha256`)]);
  if (!binaryInfo.isFile() || !sidecarInfo.isFile() || binaryInfo.size > 16 * 1024 * 1024 || sidecarInfo.size > 1024) {
    throw new Error("Invalid startup helper resources.");
  }
  const [binary, sidecar] = await Promise.all([readFile(helperPath), readFile(`${helperPath}.sha256`, "utf8")]);
  const expected = sidecar.trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(binary).digest("hex") !== expected) {
    throw new Error("Startup helper integrity check failed.");
  }
  const { stdout } = await execFileAsync(helperPath, [command], {
    windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 64 * 1024,
  });
  return stdout.trim();
}

/** Uses the inherited Windows token and normal UAC consent, without changing policy. */
export function windowsElevation(helperPath: string, run: NativeRunner = runNativeHelper) {
  return {
    async isAdministrator(): Promise<boolean> {
      const result = (await run(helperPath, "--admin-status", 15_000)).trim();
      if (result === "elevated") return true;
      if (result === "standard") return false;
      throw new Error("Windows did not return a valid administrator status.");
    },
    async requestElevation(executablePath: string): Promise<"started" | "cancelled"> {
      const expectedHelper = win32.join(win32.dirname(executablePath), "resources", "diagnostics", "ROTK.Diagnostics.exe");
      if (!win32.isAbsolute(executablePath) || executablePath.includes("\0")
        || win32.basename(executablePath).toLowerCase() !== "rotk launcher.exe"
        || win32.normalize(helperPath).toLowerCase() !== expectedHelper.toLowerCase()) {
        throw new Error("The installed launcher executable path is invalid.");
      }
      // The native helper derives the target from its own module path. No path
      // or caller-controlled command-line arguments cross the UAC boundary.
      const result = (await run(helperPath, "--elevate-launcher", 120_000)).trim();
      if (result === "started" || result === "cancelled") return result;
      throw new Error("Windows did not confirm the launcher elevation request.");
    },
  };
}

export type ElevationFailure = "check-failed" | "required" | "development" | "relaunch-failed";
export interface ElevatedStartupOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  argv: readonly string[];
}
export interface ElevatedStartupActions {
  isAdministrator(): Promise<boolean>;
  requestElevation(executablePath: string): Promise<"started" | "cancelled">;
  releaseSingleInstanceLock(): void;
  initialize(): Promise<void>;
  quit(): void;
  reportFailure(reason: ElevationFailure): void;
  mark(event: string): void;
}

/** No window, IPC handlers, account data or launch services before this gate. */
export async function startWithRequiredElevation(
  options: ElevatedStartupOptions,
  actions: ElevatedStartupActions,
): Promise<void> {
  if (options.platform !== "win32") {
    await actions.initialize();
    return;
  }
  let elevated: boolean;
  try {
    elevated = await actions.isAdministrator();
  } catch {
    actions.mark("elevation-check-failed");
    actions.reportFailure("check-failed");
    actions.quit();
    return;
  }
  if (elevated) {
    actions.mark("administrator-verified");
    await actions.initialize();
    return;
  }
  if (!options.isPackaged || options.argv.includes(ELEVATION_RELAUNCH_ARGUMENT)) {
    // The marker limits retries; it is never evidence of elevation. A source
    // checkout must be started from an elevated development terminal explicitly.
    actions.mark("administrator-required");
    actions.reportFailure(options.isPackaged ? "required" : "development");
    actions.quit();
    return;
  }
  // The elevated replacement must acquire its own lock and recheck its token.
  actions.releaseSingleInstanceLock();
  try {
    const result = await actions.requestElevation(options.executablePath);
    actions.mark(result === "started" ? "elevation-relaunched" : "elevation-cancelled");
  } catch {
    actions.mark("elevation-relaunch-failed");
    actions.reportFailure("relaunch-failed");
  }
  actions.quit();
}
