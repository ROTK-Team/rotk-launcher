import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREVIOUS_STARTUP_LOG_NAME, STARTUP_LOG_NAME, StartupLog } from "../electron/services/startup-log.js";

const PREFIX = join(tmpdir(), "rotk-startup-log-test-");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(PREFIX);
});

afterEach(async () => {
  if (!resolve(root).startsWith(resolve(PREFIX))) throw new Error("Unsafe test cleanup");
  await rm(root, { recursive: true, force: true });
});

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 19, 17, 31, 54, tick++));
}

describe("StartupLog", () => {
  it("writes one timestamped line per step, the header first", async () => {
    const directory = join(root, "ROTK Launcher");
    const log = new StartupLog(directory, fixedClock());
    log.begin("start 2.0.15 packaged=true");
    log.mark("ready");
    log.mark("window-shown", "ready-to-show");

    expect(await readFile(join(directory, STARTUP_LOG_NAME), "utf8")).toBe([
      "2026-09-19T17:31:54.000Z start 2.0.15 packaged=true",
      "2026-09-19T17:31:54.001Z ready",
      "2026-09-19T17:31:54.002Z window-shown ready-to-show",
      "",
    ].join("\n"));
  });

  it("lets the administrator relaunch go on in the same log, so the previous run is kept", async () => {
    const directory = join(root, "ROTK Launcher");
    // The run that failed, then one start of the launcher: two processes.
    const failed = new StartupLog(directory, fixedClock());
    failed.begin("start run-1");
    failed.mark("render-process-gone", "launch-failed exitCode=18");
    const shortcut = new StartupLog(directory, fixedClock());
    shortcut.begin("start run-2");
    shortcut.mark("elevation-relaunched");
    const administrator = new StartupLog(directory, fixedClock());
    administrator.begin("start run-2", true);
    administrator.mark("window-shown", "did-finish-load");

    const current = await readFile(join(directory, STARTUP_LOG_NAME), "utf8");
    expect(current.split("\n").map((line) => line.slice(25))).toEqual([
      "start run-2", "elevation-relaunched", "start run-2", "window-shown did-finish-load", "",
    ]);
    // It used to hold the two lines of the shortcut process instead.
    expect(await readFile(join(directory, PREVIOUS_STARTUP_LOG_NAME), "utf8")).toContain("launch-failed exitCode=18");
  });

  it("keeps the previous run's log under startup.previous.log", async () => {
    const log = new StartupLog(root, fixedClock());
    log.begin("start run-1");
    log.mark("render-process-gone", "launch-failed exitCode=18");
    log.begin("start run-2");

    expect(await readFile(join(root, STARTUP_LOG_NAME), "utf8")).toBe("2026-09-19T17:31:54.002Z start run-2\n");
    expect(await readFile(join(root, PREVIOUS_STARTUP_LOG_NAME), "utf8")).toBe([
      "2026-09-19T17:31:54.000Z start run-1",
      "2026-09-19T17:31:54.001Z render-process-gone launch-failed exitCode=18",
      "",
    ].join("\n"));
  });

  it("flattens a multi-line detail so it stays one breadcrumb", async () => {
    const log = new StartupLog(root, fixedClock());
    log.begin("start");
    log.mark("startup-failed", "first line\r\nsecond line\nthird");

    const lines = (await readFile(join(root, STARTUP_LOG_NAME), "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("2026-09-19T17:31:54.001Z startup-failed first line second line third");
  });

  it("never throws when the directory cannot be created", async () => {
    // A regular file where the directory should be: mkdir and every write fail.
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "occupied");
    const log = new StartupLog(blocker, fixedClock());

    expect(() => log.begin("start")).not.toThrow();
    expect(() => log.mark("ready")).not.toThrow();
    expect(await readFile(blocker, "utf8")).toBe("occupied");
  });
});
