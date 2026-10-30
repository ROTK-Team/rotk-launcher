import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosticControllerInternals } from "../electron/services/diagnostic-controller.js";

const { rotkcModuleStatus } = diagnosticControllerInternals;
const roots: string[] = [];
const since = "2026-10-28T09:00:00.000Z";

async function gameFolder(trace?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rotk-rotkc-status-test-"));
  roots.push(root);
  if (trace !== undefined) await writeFile(join(root, "rotk-vivox-v5-compat.log"), trace);
  return root;
}

const line = (at: string, pid: number, event: string) =>
  `${at} pid=${pid} tid=77 [rotk-vivoxproxy] ${event}\r\n`;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("rotkc.dll load status in the diagnostic report", () => {
  it("reads this process's line and ignores other processes and earlier sessions", async () => {
    const root = await gameFolder(
      line("2026-10-28T08:59:59.999Z", 4242, "rotkc: loaded")
      + line("2026-10-28T09:00:01.000Z", 4243, "rotkc: load failed error=126")
      + line("2026-10-28T09:00:01.100Z", 4242, "original init: ready")
      + line("2026-10-28T09:00:01.200Z", 4242, "rotkc: loaded"),
    );
    await expect(rotkcModuleStatus(root, 4242, since)).resolves.toEqual({ status: "loaded", at: "2026-10-28T09:00:01.200Z" });
    await expect(rotkcModuleStatus(root, 4243, since)).resolves.toEqual({ status: "load-failed", error: 126, at: "2026-10-28T09:00:01.000Z" });
    await expect(rotkcModuleStatus(root, 4242, "2026-10-28T09:00:02.000Z")).resolves.toEqual({ status: "not-logged" });
  });

  it("tells the legacy import search and a failed path apart", async () => {
    const root = await gameFolder(
      line("2026-10-28T09:00:01.000Z", 10, "rotkc: loader thread failed error=8, loading inline")
      + line("2026-10-28T09:00:01.001Z", 10, "rotkc: loaded with legacy import search")
      + line("2026-10-28T09:00:01.000Z", 11, "rotkc: path failed"),
    );
    await expect(rotkcModuleStatus(root, 10, since)).resolves.toMatchObject({ status: "loaded-legacy-imports" });
    await expect(rotkcModuleStatus(root, 11, since)).resolves.toMatchObject({ status: "path-failed" });
  });

  it("reads only the end of a long trace file", async () => {
    const root = await gameFolder(
      line("2026-10-28T09:00:01.000Z", 5, "rotkc: loaded")
      + "x".repeat(70 * 1024) + "\r\n"
      + line("2026-10-28T09:00:02.000Z", 6, "rotkc: loaded"),
    );
    await expect(rotkcModuleStatus(root, 5, since)).resolves.toEqual({ status: "not-logged" });
    await expect(rotkcModuleStatus(root, 6, since)).resolves.toMatchObject({ status: "loaded" });
  });

  it("never fails: no folder, no process or no trace file are reported as such", async () => {
    await expect(rotkcModuleStatus(undefined, 1, since)).resolves.toEqual({ status: "unknown" });
    await expect(rotkcModuleStatus(await gameFolder(""), null, since)).resolves.toEqual({ status: "unknown" });
    await expect(rotkcModuleStatus(await gameFolder(), 1, since)).resolves.toEqual({ status: "log-unavailable" });
    await expect(rotkcModuleStatus(await gameFolder(""), 1, since)).resolves.toEqual({ status: "not-logged" });
  });
});
