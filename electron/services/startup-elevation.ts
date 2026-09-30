import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { windowsSystemToolPath } from "./windows-tools.js";

const execFileAsync = promisify(execFile);
export const ELEVATION_RELAUNCH_ARGUMENT = "--rotk-elevation-relaunch";
type ScriptRunner = (script: string, timeoutMs: number) => Promise<string>;

const CHECK_ADMINISTRATOR = `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    [Console]::Out.Write('elevated')
  } else {
    [Console]::Out.Write('standard')
  }
} finally { $identity.Dispose() }
`;

async function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(windowsSystemToolPath("powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

/** Uses Windows' current token and normal UAC consent, without changing policy. */
export function windowsElevation(run: ScriptRunner = runPowerShell) {
  return {
    async isAdministrator(): Promise<boolean> {
      const result = (await run(CHECK_ADMINISTRATOR, 15_000)).trim();
      if (result === "elevated") return true;
      if (result === "standard") return false;
      throw new Error("Windows did not return a valid administrator status.");
    },
    async requestElevation(executablePath: string): Promise<"started" | "cancelled"> {
      if (!win32.isAbsolute(executablePath) || win32.extname(executablePath).toLowerCase() !== ".exe"
        || executablePath.includes("\0")) {
        throw new Error("The installed launcher executable path is invalid.");
      }
      // The executable path is data, never PowerShell syntax. Do not forward
      // arbitrary command-line switches or a caller-controlled working directory.
      const encodedPath = Buffer.from(executablePath, "utf8").toString("base64");
      const result = (await run(`
$ErrorActionPreference = 'Stop'
$executable = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $executable
$info.WorkingDirectory = [IO.Path]::GetDirectoryName($executable)
$info.Arguments = '${ELEVATION_RELAUNCH_ARGUMENT}'
$info.UseShellExecute = $true
$info.Verb = 'runas'
$info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
try {
  $child = [Diagnostics.Process]::Start($info)
  if ($null -eq $child) { throw 'Windows did not start the launcher.' }
  $child.Dispose()
  [Console]::Out.Write('started')
} catch {
  $failure = $_.Exception
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  if ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 1223) {
    [Console]::Out.Write('cancelled')
  } else { throw }
}
`, 120_000)).trim();
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
