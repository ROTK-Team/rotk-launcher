import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HwidReaderError, startHwidReaderProcess } from "../electron/services/hwid-reader-process";

const controllers: AbortController[] = [];
const closed: Promise<void>[] = [];
const roots: string[] = [];
function start(script: string, timeoutMs = 5_000, args: string[] = []) {
  const controller = new AbortController(); controllers.push(controller);
  const handle = startHwidReaderProcess(process.execPath, ["-e", script, ...args], { signal: controller.signal, timeoutMs });
  // Tests may wait for a readiness marker before observing the final outcome.
  void handle.output.catch(() => undefined);
  closed.push(handle.closed);
  return { ...handle, controller };
}
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  await Promise.all(closed.splice(0));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("hardware reader process ownership", () => {
  it("returns bounded output only after a successful process close", async () => {
    const handle = start("const b=Buffer.from('reader-\\u2603'); process.stdout.write(b.subarray(0,b.length-1)); process.stdout.write(b.subarray(b.length-1));");
    await expect(handle.output).resolves.toBe("reader-\u2603");
    await expect(handle.closed).resolves.toBeUndefined();
  });

  it("reports nonzero exit without exposing stderr in its error message", async () => {
    const handle = start("process.stdout.write('partial fixture'); process.stderr.write('sensitive fixture'); process.exitCode=7;");
    await expect(handle.output).rejects.toMatchObject({ reason: "execution", stdout: "partial fixture" });
    const error = await handle.output.catch(error => error);
    expect(error).toBeInstanceOf(HwidReaderError);
    expect(error.message).not.toContain("sensitive fixture");
    await handle.closed;
  });

  it.each(["stdout", "stderr"])("terminates a reader exceeding the %s output budget", async stream => {
    const handle = start(`process.${stream}.write(Buffer.alloc(300 * 1024, 65)); setInterval(()=>{}, 1000);`);
    await expect(handle.output).rejects.toMatchObject({ reason: "output_limit" });
    await handle.closed;
  });

  it("closes a timed-out process before settling its output", async () => {
    const handle = start("setInterval(()=>{}, 1000);", 100);
    await expect(handle.output).rejects.toMatchObject({ reason: "timeout" });
    await handle.closed;
  });

  it("waits for an actually running child to terminate after cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rotk-hwid-process-")); roots.push(root);
    const marker = join(root, "ready.txt");
    const handle = start("require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);", 5_000, [marker]);
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(marker, "utf8")); expect(pid).toBeGreaterThan(0); }, { timeout: 3_000 });
    handle.controller.abort();
    await expect(handle.output).rejects.toMatchObject({ reason: "cancelled" });
    await handle.closed;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("handles a missing executable without leaving the close promise pending", async () => {
    const controller = new AbortController();
    const handle = startHwidReaderProcess(join(tmpdir(), "nonexistent-rotk-reader", "missing.exe"), [], { signal: controller.signal, timeoutMs: 100 });
    await expect(handle.output).rejects.toMatchObject({ reason: "execution" });
    await expect(handle.closed).resolves.toBeUndefined();
  });

  it("does not start work for an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    const handle = startHwidReaderProcess(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal, timeoutMs: 100 });
    await expect(handle.output).rejects.toMatchObject({ reason: "cancelled" });
    await expect(handle.closed).resolves.toBeUndefined();
  });
});
