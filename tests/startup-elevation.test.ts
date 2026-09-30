import { describe, expect, it, vi } from "vitest";
import {
  ELEVATION_RELAUNCH_ARGUMENT,
  startWithRequiredElevation,
  windowsElevation,
  type ElevatedStartupActions,
  type ElevatedStartupOptions,
} from "../electron/services/startup-elevation.js";

const options: ElevatedStartupOptions = {
  platform: "win32", isPackaged: true,
  executablePath: "C:\\Program Files\\ROTK Launcher\\ROTK Launcher.exe",
  argv: ["ROTK Launcher.exe"],
};
function actions(elevated = false) {
  return {
    isAdministrator: vi.fn(async () => elevated),
    requestElevation: vi.fn(async () => "started" as const),
    releaseSingleInstanceLock: vi.fn(), initialize: vi.fn(async () => {}),
    quit: vi.fn(), reportFailure: vi.fn(), mark: vi.fn(),
  } satisfies ElevatedStartupActions;
}

describe("mandatory administrator startup", () => {
  it("initializes only after Windows confirms the current token is elevated", async () => {
    const calls = actions(true);
    await startWithRequiredElevation(options, calls);
    expect(calls.initialize).toHaveBeenCalledOnce();
    expect(calls.isAdministrator.mock.invocationCallOrder[0]).toBeLessThan(calls.initialize.mock.invocationCallOrder[0]);
    expect(calls.requestElevation).not.toHaveBeenCalled();
    expect(calls.quit).not.toHaveBeenCalled();
  });

  it("hands off the lock before UAC and never initializes the standard process", async () => {
    const calls = actions();
    await startWithRequiredElevation(options, calls);
    expect(calls.requestElevation).toHaveBeenCalledExactlyOnceWith(options.executablePath);
    expect(calls.releaseSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(calls.requestElevation.mock.invocationCallOrder[0]);
    expect(calls.initialize).not.toHaveBeenCalled();
    expect(calls.quit).toHaveBeenCalledOnce();
    expect(calls.reportFailure).not.toHaveBeenCalled();
  });

  it("closes on UAC cancellation without opening the window or retrying", async () => {
    const calls = { ...actions(), requestElevation: vi.fn(async () => "cancelled" as const) };
    await startWithRequiredElevation(options, calls);
    expect(calls.initialize).not.toHaveBeenCalled();
    expect(calls.requestElevation).toHaveBeenCalledOnce();
    expect(calls.mark).toHaveBeenCalledWith("elevation-cancelled");
    expect(calls.quit).toHaveBeenCalledOnce();
    expect(calls.reportFailure).not.toHaveBeenCalled();
  });

  it("does not treat a relaunch argument as administrator proof or loop UAC", async () => {
    const calls = actions();
    await startWithRequiredElevation({ ...options, argv: [...options.argv, ELEVATION_RELAUNCH_ARGUMENT] }, calls);
    expect(calls.isAdministrator).toHaveBeenCalledOnce();
    expect(calls.requestElevation).not.toHaveBeenCalled();
    expect(calls.initialize).not.toHaveBeenCalled();
    expect(calls.reportFailure).toHaveBeenCalledWith("required");
    expect(calls.quit).toHaveBeenCalledOnce();
  });

  it("accepts an elevated replacement only after checking its token again", async () => {
    const calls = actions(true);
    await startWithRequiredElevation({ ...options, argv: [...options.argv, ELEVATION_RELAUNCH_ARGUMENT] }, calls);
    expect(calls.isAdministrator).toHaveBeenCalledOnce();
    expect(calls.initialize).toHaveBeenCalledOnce();
    expect(calls.requestElevation).not.toHaveBeenCalled();
  });

  it("fails closed when the token query is unavailable or times out", async () => {
    const calls = actions();
    calls.isAdministrator.mockRejectedValueOnce(new Error("timed out"));
    await startWithRequiredElevation(options, calls);
    expect(calls.reportFailure).toHaveBeenCalledWith("check-failed");
    expect(calls.initialize).not.toHaveBeenCalled();
    expect(calls.requestElevation).not.toHaveBeenCalled();
    expect(calls.quit).toHaveBeenCalledOnce();
  });

  it("fails closed if Windows cannot relaunch the application", async () => {
    const calls = actions();
    calls.requestElevation.mockRejectedValueOnce(new Error("access denied"));
    await startWithRequiredElevation(options, calls);
    expect(calls.initialize).not.toHaveBeenCalled();
    expect(calls.reportFailure).toHaveBeenCalledWith("relaunch-failed");
    expect(calls.quit).toHaveBeenCalledOnce();
  });

  it("does not automatically elevate a mutable development checkout", async () => {
    const calls = actions();
    await startWithRequiredElevation({ ...options, isPackaged: false }, calls);
    expect(calls.initialize).not.toHaveBeenCalled();
    expect(calls.requestElevation).not.toHaveBeenCalled();
    expect(calls.reportFailure).toHaveBeenCalledWith("development");
    expect(calls.quit).toHaveBeenCalledOnce();
  });

  it("allows explicit elevated Windows development", async () => {
    const calls = actions(true);
    await startWithRequiredElevation({ ...options, isPackaged: false }, calls);
    expect(calls.initialize).toHaveBeenCalledOnce();
  });

  it("leaves non-Windows development independent of Windows token APIs", async () => {
    const calls = actions();
    await startWithRequiredElevation({ ...options, platform: "linux", isPackaged: false }, calls);
    expect(calls.isAdministrator).not.toHaveBeenCalled();
    expect(calls.initialize).toHaveBeenCalledOnce();
  });

  it("keeps genuine startup errors separate from permission errors", async () => {
    const calls = actions(true);
    calls.initialize.mockRejectedValueOnce(new Error("startup failed"));
    await expect(startWithRequiredElevation(options, calls)).rejects.toThrow("startup failed");
    expect(calls.reportFailure).not.toHaveBeenCalled();
  });
});

describe("Windows elevation transport", () => {
  it.each([["elevated", true], ["standard", false]] as const)("parses %s from the actual-token query", async (output, expected) => {
    const run = vi.fn(async (_script: string, _timeout: number) => output);
    expect(await windowsElevation(run).isAdministrator()).toBe(expected);
    expect(run.mock.calls[0][1]).toBe(15_000);
  });

  it.each(["", "True", "elevated\nstandard", "Administrator"])("rejects ambiguous token output %j", async (output) => {
    await expect(windowsElevation(async () => output).isAdministrator()).rejects.toThrow("valid administrator status");
  });

  it("carries paths with quotes, shell syntax and Unicode only as encoded data", async () => {
    const executable = "D:\\Jeux d'Été\\ROTK $($x);' launcher.exe";
    const run = vi.fn(async (_script: string, _timeout: number) => "started");
    expect(await windowsElevation(run).requestElevation(executable)).toBe("started");
    const script = run.mock.calls[0][0];
    expect(script).not.toContain(executable);
    const encoded = /FromBase64String\('([^']+)'\)/u.exec(script)?.[1];
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(executable);
    expect(script).toContain("$info.Verb = 'runas'");
    expect(script).toContain(`$info.Arguments = '${ELEVATION_RELAUNCH_ARGUMENT}'`);
    expect(run.mock.calls[0][1]).toBe(120_000);
  });

  it.each(["launcher.exe", "C:\\Tools\\script.ps1", "C:\\bad\0.exe"])("rejects an invalid executable path %j", async (path) => {
    const run = vi.fn(async () => "started");
    await expect(windowsElevation(run).requestElevation(path)).rejects.toThrow("path is invalid");
    expect(run).not.toHaveBeenCalled();
  });

  it("recognizes cancellation and rejects unconfirmed starts", async () => {
    expect(await windowsElevation(async () => "cancelled").requestElevation(options.executablePath)).toBe("cancelled");
    await expect(windowsElevation(async () => "").requestElevation(options.executablePath)).rejects.toThrow("confirm");
  });
});
