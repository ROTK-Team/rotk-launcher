import { describe, expect, it } from "vitest";
import { keepsLauncherAlive, mayQuitWithoutWindow, type QuitState } from "../electron/services/quit-policy";

const idle: QuitState = { windowClosedByPlayer: true, windowOpen: false, gameRunning: false, phase: "ready", diagnosticWork: false };

describe("quitting a launcher whose window was closed", () => {
  it("quits once nothing is left to wait for", () => {
    expect(mayQuitWithoutWindow(idle)).toBe(true);
  });

  it("never quits a launcher that still has its window, or one nobody closed", () => {
    expect(mayQuitWithoutWindow({ ...idle, windowOpen: true })).toBe(false);
    expect(mayQuitWithoutWindow({ ...idle, windowClosedByPlayer: false })).toBe(false);
  });

  it("waits for a game being started or running, and for the report of the last one", () => {
    expect(mayQuitWithoutWindow({ ...idle, gameRunning: true })).toBe(false);
    expect(mayQuitWithoutWindow({ ...idle, phase: "launching" })).toBe(false);
    expect(mayQuitWithoutWindow({ ...idle, phase: "running" })).toBe(false);
    expect(mayQuitWithoutWindow({ ...idle, diagnosticWork: true })).toBe(false);
  });

  it("does not wait for anything else", () => {
    for (const phase of ["unconfigured", "source-selected", "destination-selected", "installing", "ready", "error"] as const) {
      expect(keepsLauncherAlive({ gameRunning: false, phase, diagnosticWork: false })).toBe(false);
    }
  });
});
