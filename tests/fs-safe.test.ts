import { describe, expect, it } from "vitest";
import { retryFs } from "../electron/services/fs-safe.js";

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
