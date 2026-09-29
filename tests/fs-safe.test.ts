import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExecutableNotRunning,
  describeSystemError,
  installFileIfChanged,
  retryFs,
} from "../electron/services/fs-safe.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitest-fs-safe-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function systemError(code: string, path?: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code, path, syscall });
}

describe("retryFs", () => {
  it("retries transient Windows lock errors", async () => {
    let calls = 0;
    const value = await retryFs(async () => {
      calls += 1;
      if (calls < 3) throw systemError("EBUSY");
      return "done";
    }, { baseDelayMs: 1 });
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(retryFs(async () => {
      calls += 1;
      throw systemError("ENOENT");
    }, { baseDelayMs: 1 })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    await expect(retryFs(async () => {
      calls += 1;
      throw systemError("EPERM");
    }, { attempts: 4, baseDelayMs: 1 })).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(4);
  });
});

describe("installFileIfChanged", () => {
  it("leaves an identical target alone and replaces a different one", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.dll");
    const target = join(root, "target.dll");
    await writeFile(source, "shim-v2");
    await writeFile(target, "shim-v2");
    const before = await stat(target);

    await expect(installFileIfChanged(source, target)).resolves.toBe(false);
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);

    await writeFile(target, "vanilla");
    await expect(installFileIfChanged(source, target)).resolves.toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("shim-v2");
  });
});

describe("assertExecutableNotRunning", () => {
  it("accepts an executable nobody holds, and a missing one", async () => {
    const root = await temporaryRoot();
    const executable = join(root, "H1Z1.exe");
    await writeFile(executable, "MZ");
    await expect(assertExecutableNotRunning(executable)).resolves.toBeUndefined();
    await expect(assertExecutableNotRunning(join(root, "missing.exe"))).resolves.toBeUndefined();
  });
});

describe("describeSystemError", () => {
  const resources = "C:\\Program Files\\ROTK Launcher\\resources";

  it("names the file for locks and points at the antivirus", () => {
    const message = describeSystemError(
      systemError("EPERM", "D:\\Games\\ROTK\\steam_api64.dll", "rename"),
      resources,
    );
    expect(message).toContain("D:\\Games\\ROTK\\steam_api64.dll");
    expect(message).toContain("EPERM, rename");
    expect(message).toContain("antivirus");
  });

  it("reports a missing bundled file as a likely quarantine", () => {
    const message = describeSystemError(
      systemError("ENOENT", `${resources}\\patches\\dinput8.dll`, "open"),
      resources,
    );
    expect(message).toMatch(/quarantaine/);
  });

  it("keeps a plain code when there is no path", () => {
    expect(describeSystemError(systemError("ECONNRESET"), resources)).toBe("Erreur système (ECONNRESET).");
  });
});
