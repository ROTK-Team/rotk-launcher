import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertExecutableNotRunning } from "../electron/services/game-launcher.js";

describe("assertExecutableNotRunning", () => {
  it("accepts an executable nobody holds, and a missing one", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitest-game-launcher-"));
    try {
      const executable = join(root, "H1Z1.exe");
      await writeFile(executable, "MZ");
      await expect(assertExecutableNotRunning(executable)).resolves.toBeUndefined();
      await expect(assertExecutableNotRunning(join(root, "missing.exe"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === "win32")("assertExecutableNotRunning on a live process", () => {
  it("detects a running H1Z1.exe, read-only or not", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitest-game-launcher-"));
    const executable = join(root, "H1Z1.exe");
    await copyFile(join(process.env.SystemRoot ?? "C:\Windows", "System32", "PING.EXE"), executable);
    const child = spawn(executable, ["-n", "5", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
    try {
      await new Promise((resolveSpawn, rejectSpawn) => child.once("spawn", resolveSpawn).once("error", rejectSpawn));
      await expect(assertExecutableNotRunning(executable, 1)).rejects.toThrow(/déjà lancé/);
      // Read-only: the write open fails with EPERM, the process list decides.
      await chmod(executable, 0o444);
      await expect(assertExecutableNotRunning(executable, 1)).rejects.toThrow(/déjà lancé/);
    } finally {
      child.kill();
      await new Promise((resolveExit) => child.once("exit", resolveExit));
      await chmod(executable, 0o666);
      await rm(root, { recursive: true, force: true });
    }
  });
});
