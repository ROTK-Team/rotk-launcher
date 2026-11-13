import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// Error codes the next reads fail with, in order; empty means a real read.
const failures = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const code = failures.queue.shift();
      if (!code) return actual.createReadStream(...args);
      return new Readable({ read() { this.destroy(Object.assign(new Error(code), { code, path: String(args[0]) })); } });
    },
  };
});

import { fileHashOrEmpty } from "../electron/services/file-hash.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rotk-file-hash-test-"));
  roots.push(root);
  const path = join(root, "H1Z1.exe");
  await writeFile(path, "fixture bytes");
  return path;
}
afterEach(async () => {
  vi.useRealTimers();
  failures.queue.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("fileHashOrEmpty", () => {
  it("hashes a readable file and returns an empty digest for a missing one", async () => {
    const path = await fixture();
    expect(await fileHashOrEmpty(path)).toBe(createHash("sha256").update("fixture bytes").digest("hex"));
    expect(await fileHashOrEmpty(join(path, "..", "absent.dll"))).toBe("");
  });

  it("waits for a file another program holds for a moment", async () => {
    const path = await fixture();
    failures.queue.push("EBUSY", "EBUSY");
    expect(await fileHashOrEmpty(path)).toBe(createHash("sha256").update("fixture bytes").digest("hex"));
    expect(failures.queue).toHaveLength(0);
  });

  it("reports a file that stays held instead of passing it for a different file", async () => {
    vi.useFakeTimers();
    const path = await fixture();
    failures.queue.push(...Array<string>(20).fill("EPERM"));
    const held = fileHashOrEmpty(path).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await held).toMatchObject({ code: "EPERM", path });
  });
});
