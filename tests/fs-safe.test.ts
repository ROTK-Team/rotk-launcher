import { describe, expect, it } from "vitest";
import { describeSystemError, retryFs } from "../electron/services/fs-safe.js";

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
