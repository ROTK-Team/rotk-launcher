import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertExecutableNotRunning, stopGameFromInstallation } from "../electron/services/game-launcher.js";

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
      await expect(assertExecutableNotRunning(executable, 1)).rejects.toMatchObject({ code: "game_already_running", executablePath: executable });
      // Read-only: the write open fails with EPERM, the process list decides.
      await chmod(executable, 0o444);
      // A name match could be another copy: no path, so no offer to close it.
      await expect(assertExecutableNotRunning(executable, 1)).rejects.toMatchObject({ code: "game_already_running", executablePath: undefined });
    } finally {
      child.kill();
      await new Promise((resolveExit) => child.once("exit", resolveExit));
      await chmod(executable, 0o666);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === "win32")("stopGameFromInstallation", () => {
  it("ends the H1Z1 of this installation only", async () => {
    // As the launcher does: the physical path, here with a space and an accent.
    const roots = await Promise.all(["vitest stray é a-", "vitest stray é b-"].map(async (prefix) => realpath(await mkdtemp(join(tmpdir(), prefix)))));
    const executables = roots.map((root) => join(root, "H1Z1.exe"));
    const children: ReturnType<typeof spawn>[] = [];
    try {
      for (const executable of executables) {
        await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"), executable);
        const child = spawn(executable, ["-n", "60", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
        children.push(child);
        await new Promise((resolveSpawn, rejectSpawn) => child.once("spawn", resolveSpawn).once("error", rejectSpawn));
      }
      const exited = new Promise((resolveExit) => children[0]!.once("exit", resolveExit));
      expect(await stopGameFromInstallation(executables[0]!)).toBe(1);
      await exited;
      expect(children[1]!.exitCode).toBeNull();
      // Already gone (it ended while the question was open): nothing to end, no error.
      expect(await stopGameFromInstallation(executables[0]!)).toBe(0);
      expect(await stopGameFromInstallation("")).toBe(0);
      await expect(assertExecutableNotRunning(executables[0]!, 1)).resolves.toBeUndefined();
      expect(children[1]!.exitCode).toBeNull();
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exitCode === null ? new Promise((done) => child.once("exit", done)) : null));
      for (const root of roots) await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
