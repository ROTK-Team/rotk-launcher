import { describe, expect, it } from "vitest";
import { STARTUP_READ_WAIT_MS, readWhenFree } from "../electron/services/startup-read";

function held(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: file in use`), { code });
}

/** A clock that only moves when the reader pauses. */
function clock() {
  let time = 0;
  return { now: () => time, pause: async (milliseconds: number) => { time += milliseconds; }, elapsed: () => time };
}

describe("reading a file the launcher needs to start", () => {
  it("returns at once when the file is free", async () => {
    const time = clock();
    expect(await readWhenFree(async () => "config", time)).toBe("config");
    expect(time.elapsed()).toBe(0);
  });

  it("waits for a file another program holds, and says so once", async () => {
    const time = clock();
    const waits: string[] = [];
    let reads = 0;
    const value = await readWhenFree(async () => {
      reads += 1;
      if (reads <= 4) throw held(reads % 2 ? "EBUSY" : "EPERM");
      return "keys";
    }, { ...time, onWait: (code) => waits.push(code) });
    expect(value).toBe("keys");
    expect(reads).toBe(5);
    expect(waits).toEqual(["EBUSY"]);
    expect(time.elapsed()).toBeLessThan(STARTUP_READ_WAIT_MS);
  });

  it("gives the error back when the file is still held at the end of the wait", async () => {
    const time = clock();
    await expect(readWhenFree(async () => { throw held("EACCES"); }, time)).rejects.toMatchObject({ code: "EACCES" });
    expect(time.elapsed()).toBe(STARTUP_READ_WAIT_MS);
  });

  it("does not wait for any other failure", async () => {
    const time = clock();
    await expect(readWhenFree(async () => { throw held("EIO"); }, time)).rejects.toMatchObject({ code: "EIO" });
    await expect(readWhenFree(async () => { throw new Error("corrupt"); }, time)).rejects.toThrow("corrupt");
    expect(time.elapsed()).toBe(0);
  });
});
