import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HWID_CORE_SLOTS, HWID_KNOWN_SLOTS, buildHwidScript, cleanComponent,
  collectHwid, collectHwidResult, parseHwidOutput, selectHwidSlots, groupHwidSlots, HWID_READER_CONCURRENCY,
} from "../electron/services/machine-identity";
import { HwidReaderError, type HwidReaderOptions, type HwidReaderHandle } from "../electron/services/hwid-reader-process";
import { assertHwidEvidence } from "../electron/services/hwid-evidence";

const row = (slot: string, value: string) => JSON.stringify({ slot, status: "ok", value });
const scriptSlots = (script: string): string[] => [...new Set([...script.matchAll(/slot = '([a-z_]+)'/g)].map(match => match[1]))];
const rowsFor = (script: string, values: Record<string, string> = {}) => scriptSlots(script).map(slot => row(slot, values[slot] ?? "value")).join("\n");
// No child process exists in scheduler tests. Process ownership is tested separately.
const reader = (run: (script: string, options: HwidReaderOptions) => Promise<string>) => ({
  startReader: (script: string, options: HwidReaderOptions): HwidReaderHandle => ({
    output: Promise.resolve().then(() => run(script, options)), closed: Promise.resolve(),
  }),
});
const windows = { platform: "win32" as const };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("hardware evidence validation", () => {
  it("normalizes measurements but never normalizes a vector already covered by a proof", () => {
    expect(cleanComponent("  Real-Serial-123 ")).toBe("real-serial-123");
    const signed = { machine_guid: " Real-Serial-123 " };
    assertHwidEvidence(signed);
    expect(signed.machine_guid).toBe(" Real-Serial-123 ");
  });

  it.each(["", "To be filled by O.E.M.", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "System Serial Number", null,
    "secret\0slot=value", "a\nb", "a\tb", "x".repeat(1025)])("rejects placeholder or invalid value %j", value => {
    expect(cleanComponent(value)).toBeUndefined();
  });

  it("rejects getters and non-enumerable evidence before signing or serialization", () => {
    const getter = vi.fn(() => "first-value");
    const accessor = Object.defineProperty({}, "machine_guid", { enumerable: true, get: getter });
    expect(() => assertHwidEvidence(accessor)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => assertHwidEvidence(Object.defineProperty({}, "machine_guid", { value: "hidden" }))).toThrow();
  });

  it("rejects oversized vectors and inherited evidence", () => {
    expect(() => assertHwidEvidence(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`slot_${i}`, "value"]))))
      .toThrow();
    expect(() => assertHwidEvidence(Object.create({ machine_guid: "value" }))).toThrow();
  });
});

describe("collector script and output", () => {
  it("only builds fixed known readers, with one independently emitted result per slot", () => {
    for (const slot of HWID_CORE_SLOTS) expect(HWID_KNOWN_SLOTS).toContain(slot);
    expect(selectHwidSlots(["gpu_name", "machine_guid", "gpu_name", "unknown_slot"]))
      .toEqual(["gpu_name", "machine_guid"]);
    const script = buildHwidScript(["machine_guid", "cpu_name"]);
    expect(script).toContain("[Console]::OutputEncoding");
    expect(script).toContain("slot = 'machine_guid'");
    expect(script).toContain("slot = 'cpu_name'");
    expect(script.match(/ConvertTo-Json/g)).toHaveLength(2);
    expect(() => buildHwidScript(["unknown; command"])).toThrow();
  });

  it("parses UTF-8 rows and distinguishes unavailable values from failed reads", () => {
    const parsed = parseHwidOutput("\uFEFF" + [
      row("machine_guid", " GUID "), row("bios_serial", "To be filled by O.E.M."),
      JSON.stringify({ slot: "disk_serial", status: "permission_denied" }),
    ].join("\r\n"), ["machine_guid", "bios_serial", "disk_serial"]);
    expect(parsed).toEqual({ hwid: { machine_guid: "guid" }, slots: {
      machine_guid: "ok", bios_serial: "missing", disk_serial: "permission_denied",
    } });
  });

  it.each(["not json", "[]", "null", row("unrequested", "value"),
    row("machine_guid", "a") + "\n" + row("machine_guid", "b"),
    JSON.stringify({ slot: "machine_guid", status: "ok", value: 42 }),
    JSON.stringify({ slot: "machine_guid", status: "ignored" }),
    "x".repeat(256 * 1024 + 1),
  ])("rejects malformed, duplicate, unrequested or oversized output (case %#)", stdout => {
    expect(() => parseHwidOutput(stdout, ["machine_guid"])).toThrow();
  });
});

describe("bounded hardware collection on every test platform", () => {
  it("collects the exact requested slots and freezes the vector before signing", async () => {
    const run = vi.fn(async (script: string) => rowsFor(script, { machine_guid: "MG-1", bios_serial: "BIOS-2" }));
    const vector = await collectHwid(["machine_guid", "bios_serial"], { ...windows, ...reader(run) });
    expect(vector).toEqual({ machine_guid: "mg-1", bios_serial: "bios-2" });
    expect(Object.isFrozen(vector)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses the core slots by default", async () => {
    const run = vi.fn(async (script: string) => rowsFor(script));
    await collectHwid(undefined, { ...windows, ...reader(run) });
    expect(run).toHaveBeenCalledTimes(3);
    const scripts = run.mock.calls.map(([script]) => script).join("\n");
    for (const slot of HWID_CORE_SLOTS) expect(scripts).toContain(`slot = '${slot}'`);
  });

  it("permits explicit missing optional measurements only when some usable evidence remains", async () => {
    const result = await collectHwidResult(["machine_guid", "bios_serial"], {
      ...windows, ...reader(async script => rowsFor(script, { machine_guid: "mg-1", bios_serial: "none" })),
    });
    expect(result.status).toBe("complete");
    expect(result.slots.bios_serial).toBe("missing");
    expect(result.hwid).toEqual({ machine_guid: "mg-1" });
  });

  it.each(["", row("disk_serial", "none"), "{truncated", row("disk_serial", "value"),
    row("disk_serial", "value") + "\n" + JSON.stringify({ slot: "volume_serial", status: "error" }),
    row("disk_serial", "value") + "\n" + JSON.stringify({ slot: "volume_serial", status: "permission_denied" }),
    row("disk_serial", "value") + "\n" + row("volume_serial", "value\0invalid"),
  ])("blocks empty, incomplete and failed attempts despite earlier successful reads (case %#)", async stdout => {
    await expect(collectHwid(["disk_serial", "volume_serial"], { ...windows, ...reader(async () => stdout) }))
      .rejects.toMatchObject({ code: "hwid_verification_failed" });
  });

  it.each(["\n", "\tnone", " ".repeat(1025)])("does not downgrade malformed values to ordinary missing measurements (case %#)", async value => {
    const result = await collectHwidResult(["disk_serial", "volume_serial"], {
      ...windows, ...reader(async () => row("disk_serial", "valid") + "\n" + row("volume_serial", value)),
    });
    expect(result).toMatchObject({ status: "failed", failure: "invalid_output", slots: { volume_serial: "invalid_value" } });
  });

  it("keeps partial timeout output as diagnostics, never as successful evidence", async () => {
    const run = async () => { throw new HwidReaderError("timeout", row("disk_serial", "private-value") + "\n"); };
    const result = await collectHwidResult(["disk_serial", "volume_serial"], { ...windows, ...reader(run) });
    expect(result).toMatchObject({ status: "failed", failure: "timeout", slots: { disk_serial: "ok", volume_serial: "timeout" } });
    try { await collectHwid(["disk_serial", "volume_serial"], { ...windows, ...reader(run) }); throw new Error("unexpected success"); }
    catch (error) {
      expect(error).toMatchObject({ code: "hwid_verification_failed", reason: "timeout" });
      expect(String(error)).not.toContain("private-value");
    }
  });

  it("bounds a hung operation and signals cancellation without depending on a response", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const pending = collectHwidResult(["machine_guid"], { ...windows, timeoutMs: 50, ...reader(async (_script, options) => {
      signal = options.signal;
      return new Promise<string>(() => {});
    }) });
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toMatchObject({ status: "failed", failure: "timeout" });
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a late result even if event-loop starvation delays the timeout callback", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await expect(collectHwid(["machine_guid"], { ...windows, timeoutMs: 50, ...reader(async () => {
      now = 100;
      return row("machine_guid", "value");
    }) }))
      .rejects.toMatchObject({ reason: "timeout" });
  });

  it("rejects a completed attempt containing only placeholders across every group", async () => {
    const result = await collectHwidResult(["machine_guid", "bios_serial"], {
      ...windows, ...reader(async script => rowsFor(script, { machine_guid: "none", bios_serial: "none" })),
    });
    expect(result).toMatchObject({ status: "failed", failure: "empty" });
  });

  it("honors cancellation before and during collection", async () => {
    const before = new AbortController(); before.abort();
    const unused = vi.fn();
    await expect(collectHwid(["machine_guid"], { ...windows, signal: before.signal, ...reader(unused) }))
      .rejects.toMatchObject({ reason: "cancelled" });
    expect(unused).not.toHaveBeenCalled();
    const during = new AbortController();
    const run = vi.fn(async () => { during.abort(); return row("machine_guid", "value"); });
    await expect(collectHwid(["machine_guid"], { ...windows, signal: during.signal, ...reader(run) }))
      .rejects.toMatchObject({ reason: "cancelled" });
  });

  it("does not silently drop unknown requested slots or self-exempt on another platform", async () => {
    const run = vi.fn();
    await expect(collectHwid(["machine_guid", "future_slot"], { ...windows, ...reader(run) }))
      .rejects.toMatchObject({ reason: "unsupported" });
    await expect(collectHwid(["machine_guid"], { platform: "linux", ...reader(run) }))
      .rejects.toMatchObject({ reason: "unsupported" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 60001])("rejects invalid timeout %s before spawning", async timeoutMs => {
    const run = vi.fn();
    await expect(collectHwid(["machine_guid"], { ...windows, ...reader(run), timeoutMs })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});


describe("hardware reader scheduling", () => {
  const requested = ["machine_guid", "bios_serial", "disk_serial", "cpu_name", "mac_addresses", "monitor_edid_serials", "os_install_date"];

  it("assigns every known slot to exactly one fixed source group", () => {
    const grouped = groupHwidSlots(HWID_KNOWN_SLOTS).flatMap(group => group.slots);
    expect([...grouped].sort()).toEqual([...HWID_KNOWN_SLOTS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("limits concurrency and waits for close before admitting another reader", async () => {
    const opened: Array<{ script: string; finish: () => void; close: () => void }> = [];
    let active = 0, maximum = 0;
    const startReader = (script: string): HwidReaderHandle => {
      active++; maximum = Math.max(maximum, active);
      let finish!: () => void, close!: () => void;
      const output = new Promise<string>(resolve => { finish = () => resolve(rowsFor(script)); });
      const closed = new Promise<void>(resolve => { close = () => { active--; resolve(); }; });
      opened.push({ script, finish, close });
      return { output, closed };
    };
    const pending = collectHwidResult(requested, { ...windows, startReader });
    expect(opened).toHaveLength(HWID_READER_CONCURRENCY);
    opened[0].finish();
    await new Promise(resolve => setImmediate(resolve));
    expect(opened).toHaveLength(2); // output alone does not release the worker slot
    opened[0].close();
    await new Promise(resolve => setImmediate(resolve));
    expect(opened).toHaveLength(3);
    for (let index = 1; index < requested.length; index++) {
      opened[index].finish(); opened[index].close();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect((await pending).status).toBe("complete");
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("a group timeout cancels siblings and does not start queued groups", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const startReader = vi.fn((_script: string, options: HwidReaderOptions): HwidReaderHandle => {
      signals.push(options.signal);
      return { output: new Promise(() => {}), closed: Promise.resolve() };
    });
    const pending = collectHwidResult(requested, { ...windows, timeoutMs: 100, groupTimeoutMs: 20, startReader });
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ status: "failed", failure: "timeout" });
    expect(startReader).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the overall budget includes queued groups and caps their remaining time", async () => {
    vi.useFakeTimers();
    const budgets: number[] = [];
    const run = async (script: string, options: HwidReaderOptions) => {
      budgets.push(options.timeoutMs);
      await new Promise(resolve => setTimeout(resolve, 15));
      return rowsFor(script);
    };
    const pending = collectHwidResult(requested, { ...windows, timeoutMs: 25, groupTimeoutMs: 20, ...reader(run) });
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toMatchObject({ status: "failed", failure: "timeout" });
    expect(budgets).toHaveLength(4);
    expect(budgets[2]).toBeLessThanOrEqual(10);
    await vi.advanceTimersByTimeAsync(10); // late injected results have no effect
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed group cannot be masked by a successful sibling", async () => {
    const run = async (script: string) => script.includes("slot = 'bios_serial'")
      ? JSON.stringify({ slot: "bios_serial", status: "permission_denied" }) : rowsFor(script);
    const result = await collectHwidResult(requested, { ...windows, ...reader(run) });
    expect(result).toMatchObject({ status: "failed", failure: "execution" });
    expect(result.slots.bios_serial).toBe("permission_denied");
  });

  it("cancellation stops active readers and waits for their close acknowledgements", async () => {
    const controller = new AbortController();
    const close: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const startReader = (_script: string, options: HwidReaderOptions): HwidReaderHandle => {
      signals.push(options.signal);
      return { output: new Promise(() => {}), closed: new Promise(resolve => close.push(resolve)) };
    };
    let settled = false;
    const pending = collectHwidResult(requested, { ...windows, signal: controller.signal, startReader }).then(result => { settled = true; return result; });
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(settled).toBe(false);
    close.forEach(resolve => resolve());
    expect(await pending).toMatchObject({ status: "cancelled" });
  });

  it("handles synchronous cancellation during process creation without starting queued readers", async () => {
    const controller = new AbortController();
    const startReader = vi.fn((script: string): HwidReaderHandle => {
      controller.abort();
      return { output: Promise.resolve(rowsFor(script)), closed: Promise.resolve() };
    });
    await expect(collectHwidResult(requested, { ...windows, signal: controller.signal, startReader }))
      .resolves.toMatchObject({ status: "cancelled", hwid: {} });
    expect(startReader).toHaveBeenCalledTimes(1);
  });

  it("late output from a cancelled attempt cannot change its result or the next attempt", async () => {
    const controller = new AbortController();
    let late!: (output: string) => void;
    const pending = collectHwidResult(["machine_guid"], { ...windows, signal: controller.signal,
      startReader: () => ({ output: new Promise(resolve => { late = resolve; }), closed: Promise.resolve() }),
    });
    controller.abort();
    const cancelled = await pending;
    const next = await collectHwid(["machine_guid"], { ...windows, ...reader(async () => row("machine_guid", "new")) });
    late(row("machine_guid", "old"));
    await new Promise(resolve => setImmediate(resolve));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.hwid).toEqual({});
    expect(next).toEqual({ machine_guid: "new" });
  });
});
