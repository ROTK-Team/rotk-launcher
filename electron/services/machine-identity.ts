/**
 * Composite hardware fingerprint (Windows).
 *
 * Reads the slots requested by the signed challenge, or the core set when
 * no slots are specified. Only fixed, known readers can reach PowerShell.
 * Hardware values are untrusted userland observations, not proof of identity.
 * Collection failures block this launcher. The server must independently
 * validate evidence quality, TPM trust and bans for every admission route.
 * No raw measurements are persisted or included in thrown errors here.
 */

import { assertHwidEvidence, HwidVerificationError, isHwidPlaceholder, MAX_HWID_SLOTS, isUsableHwidValue } from "./hwid-evidence.js";

import { windowsSystemToolPath } from "./windows-tools.js";

import { HwidReaderError, startHwidReaderProcess, type HwidReaderHandle, type HwidReaderOptions } from "./hwid-reader-process.js";

export const HWID_READER_CONCURRENCY = 2;
export const HWID_COLLECTION_TIMEOUT_MS = 10_000;
export const HWID_GROUP_TIMEOUT_MS = 5_000;

/** The slots every launch answers; the server's HWID_CORE_COMPONENTS. */
export const HWID_CORE_SLOTS = [
  "machine_guid", "smbios_uuid", "baseboard_serial", "disk_serial", "volume_serial",
] as const;

/**
 * Every slot this launcher can read, with the PowerShell expression that reads
 * it. Fixed text only. A challenge naming an unsupported reader blocks this
 * launcher rather than silently dropping part of the requested evidence.
 */
const SLOT_READERS: Readonly<Record<string, string>> = Object.freeze({
  machine_guid: "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid",
  smbios_uuid: "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
  baseboard_serial: "(Get-CimInstance Win32_BaseBoard).SerialNumber",
  baseboard_product: "(Get-CimInstance Win32_BaseBoard).Product",
  disk_serial: "(Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 } | Select-Object -First 1).SerialNumber",
  disk_model: "(Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 } | Select-Object -First 1).Model",
  disk_firmware: "(Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 } | Select-Object -First 1).FirmwareRevision",
  volume_serial: "(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$($env:SystemDrive)'\").VolumeSerialNumber",
  bios_serial: "(Get-CimInstance Win32_BIOS).SerialNumber",
  bios_version: "(Get-CimInstance Win32_BIOS).SMBIOSBIOSVersion",
  bios_release_date: "(Get-CimInstance Win32_BIOS).ReleaseDate.ToString('yyyy-MM-dd')",
  cpu_processor_id: "(Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId",
  cpu_name: "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name",
  ram_module_serials: "((Get-CimInstance Win32_PhysicalMemory | ForEach-Object { $_.SerialNumber } | Where-Object { $_ } | Sort-Object) -join ',')",
  gpu_pnp_device_id: "(Get-CimInstance Win32_VideoController | Select-Object -First 1).PNPDeviceID",
  gpu_name: "(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name",
  mac_addresses: "((Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=True' | ForEach-Object { $_.MACAddress } | Where-Object { $_ } | Sort-Object -Unique) -join ',')",
  monitor_edid_serials: "((Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID | ForEach-Object { -join ($_.SerialNumberID | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) } | Where-Object { $_ } | Sort-Object) -join ',')",
  os_install_date: "(Get-CimInstance Win32_OperatingSystem).InstallDate.ToString('yyyy-MM-dd')",
  enclosure_serial: "(Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1).SerialNumber",
  system_sku: "(Get-CimInstance Win32_ComputerSystem).SystemSKUNumber",
});

/** Fixed source families; never derived from shell text supplied by a server. */
const READER_GROUPS = [
  { id: "registry", slots: ["machine_guid"] },
  { id: "firmware", slots: ["smbios_uuid", "baseboard_serial", "baseboard_product", "bios_serial", "bios_version", "bios_release_date", "enclosure_serial", "system_sku"] },
  { id: "storage", slots: ["disk_serial", "disk_model", "disk_firmware", "volume_serial"] },
  { id: "compute", slots: ["cpu_processor_id", "cpu_name", "ram_module_serials", "gpu_pnp_device_id", "gpu_name"] },
  { id: "network", slots: ["mac_addresses"] },
  { id: "display", slots: ["monitor_edid_serials"] },
  { id: "os", slots: ["os_install_date"] },
] as const;

export interface HwidReaderGroup {
  readonly id: string;
  readonly slots: readonly string[];
}

export function groupHwidSlots(slots: readonly string[]): HwidReaderGroup[] {
  return READER_GROUPS.map(group => ({ id: group.id, slots: group.slots.filter(slot => slots.includes(slot)) }))
    .filter(group => group.slots.length > 0);
}

/** Every slot name this launcher knows how to read. */
export const HWID_KNOWN_SLOTS: readonly string[] = Object.freeze(Object.keys(SLOT_READERS));

/** Trim, collapse whitespace, lowercase, and reject known placeholders. */
export function cleanComponent(value: string | undefined | null): string | undefined {
  if (!isUsableHwidValue(value)) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  return isUsableHwidValue(normalized) ? normalized : undefined;
}

/**
 * The slots to read: the requested names this launcher knows, deduplicated,
 * in request order. The collection entry point separately rejects unsupported
 * requests; this selection helper never turns arbitrary text into shell code.
 */
export function selectHwidSlots(requested: readonly string[]): string[] {
  const slots: string[] = [];
  for (const slot of requested) {
    if (Object.prototype.hasOwnProperty.call(SLOT_READERS, slot) && !slots.includes(slot)) slots.push(slot);
  }
  return slots;
}

/** Each completed read is emitted separately, so a later timeout retains diagnostics. */
export function buildHwidScript(slots: readonly string[]): string {
  if (slots.length > MAX_HWID_SLOTS || selectHwidSlots(slots).length !== slots.length) {
    throw new HwidVerificationError("invalid");
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    ...slots.map((slot) => [
      `try { $v = [string](${SLOT_READERS[slot]});`,
      `$r = @{ slot = '${slot}'; status = 'ok'; value = $v }`,
      `} catch { $s = 'error'; if ($_.Exception -is [System.UnauthorizedAccessException]) { $s = 'permission_denied' };`,
      `$r = @{ slot = '${slot}'; status = $s } }`,
      "$r | ConvertTo-Json -Compress",
    ].join("\n")),
  ].join("\n");
}

export type HwidSlotStatus = "ok" | "missing" | "unsupported" | "permission_denied" | "timeout" | "error" | "invalid_value" | "cancelled" | "not_collected";
export interface HwidCollectionResult {
  readonly status: "complete" | "failed" | "unsupported" | "cancelled";
  readonly hwid: Record<string, string>;
  readonly slots: Record<string, HwidSlotStatus>;
  readonly durationMs: number;
  readonly failure?: "timeout" | "execution" | "invalid_output" | "empty";
}

/** Parse the bounded, line-delimited output of our fixed collector script. */
export function parseHwidOutput(stdout: string, slots: readonly string[]): Pick<HwidCollectionResult, "hwid" | "slots"> {
  if (Buffer.byteLength(stdout, "utf8") > 256 * 1024) throw new HwidVerificationError("invalid");
  const hwid: Record<string, string> = {};
  const outcomes: Record<string, HwidSlotStatus> = {};
  for (const line of stdout.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { throw new HwidVerificationError("invalid"); }
    if (!record || typeof record !== "object" || Array.isArray(record)
      || typeof record.slot !== "string" || !slots.includes(record.slot)
      || Object.hasOwn(outcomes, record.slot)) throw new HwidVerificationError("invalid");
    const slot = record.slot;
    if (record.status === "error" || record.status === "permission_denied") {
      outcomes[slot] = record.status;
    } else if (record.status === "ok" && typeof record.value === "string") {
      const value = cleanComponent(record.value);
      if (value !== undefined) { hwid[slot] = value; outcomes[slot] = "ok"; }
      else outcomes[slot] = isHwidPlaceholder(record.value)
        ? "missing" : "invalid_value";
    } else throw new HwidVerificationError("invalid");
  }
  return { hwid, slots: outcomes };
}

export interface HwidCollectionOptions {
  /** Test seam. Handles must retain ownership until their child has closed. */
  startReader?: (script: string, options: HwidReaderOptions) => HwidReaderHandle;
  timeoutMs?: number;
  groupTimeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; never supplied by the renderer or read from an environment flag. */
  platform?: NodeJS.Platform;
}

function startPowerShell(script: string, options: HwidReaderOptions): HwidReaderHandle {
  return startHwidReaderProcess(
    windowsSystemToolPath("powershell"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")],
    options,
  );
}

/** One attempt, two readers at most, separate group budgets and one overall deadline. */
export async function collectHwidResult(
  requested: readonly string[] = HWID_CORE_SLOTS,
  options: HwidCollectionOptions = {},
): Promise<HwidCollectionResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? HWID_COLLECTION_TIMEOUT_MS;
  const groupTimeoutMs = options.groupTimeoutMs ?? HWID_GROUP_TIMEOUT_MS;
  const validTimeout = (value: number): boolean => Number.isFinite(value) && value > 0 && value <= 60_000;
  if (!validTimeout(timeoutMs) || !validTimeout(groupTimeoutMs)
    || requested.length === 0 || requested.length > MAX_HWID_SLOTS
    || requested.some(slot => !/^[a-z0-9_]{1,40}$/.test(slot))
    || new Set(requested).size !== requested.length) throw new HwidVerificationError("invalid");
  const slots = selectHwidSlots(requested);
  const outcomes: Record<string, HwidSlotStatus> = Object.fromEntries(requested.map(slot => [slot, "unsupported"]));
  const hwid: Record<string, string> = {};
  const result = (status: HwidCollectionResult["status"], failure?: HwidCollectionResult["failure"]): HwidCollectionResult => ({
    status, hwid: Object.freeze({ ...hwid }), slots: Object.freeze({ ...outcomes }),
    durationMs: Math.max(0, performance.now() - started), ...(failure ? { failure } : {}),
  });
  if (options.signal?.aborted) return result("cancelled");
  if ((options.platform ?? process.platform) !== "win32" || slots.length !== requested.length) return result("unsupported");
  for (const slot of slots) outcomes[slot] = "not_collected";
  const groups = groupHwidSlots(slots);
  const attempt = new AbortController();
  const handles: HwidReaderHandle[] = [];
  let failure: HwidCollectionResult["failure"];
  let nextGroup = 0;
  const fail = (reason: NonNullable<HwidCollectionResult["failure"]>): void => {
    failure ??= reason;
    attempt.abort();
  };
  const cancel = (): void => attempt.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const overallTimer = setTimeout(() => fail("timeout"), timeoutMs);

  const runGroup = async (group: HwidReaderGroup): Promise<void> => {
    const groupStarted = performance.now();
    const budget = Math.min(groupTimeoutMs, timeoutMs - (groupStarted - started));
    if (budget <= 0) { fail("timeout"); return; }
    if (attempt.signal.aborted) return;
    const controller = new AbortController();
    let expired = false;
    let rejectInterrupted!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    const abort = (): void => {
      controller.abort();
      rejectInterrupted(new HwidReaderError("cancelled"));
    };
    attempt.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
      rejectInterrupted(new HwidReaderError("timeout"));
    }, budget);
    let handle: HwidReaderHandle | undefined;
    try {
      // Attach a rejection observer before invoking an injected reader which
      // may synchronously cancel the whole attempt.
      void interrupted.catch(() => undefined);
      handle = (options.startReader ?? startPowerShell)(buildHwidScript(group.slots), {
        signal: controller.signal, timeoutMs: budget,
      });
      handles.push(handle);
      const stdout = await Promise.race([handle.output, interrupted]);
      if (attempt.signal.aborted) {
        for (const slot of group.slots) outcomes[slot] = "cancelled";
        return;
      }
      if (performance.now() - groupStarted >= budget || performance.now() - started >= timeoutMs) {
        expired = true;
        throw new HwidReaderError("timeout");
      }
      const parsed = parseHwidOutput(stdout, group.slots);
      if (performance.now() - groupStarted >= budget || performance.now() - started >= timeoutMs) {
        expired = true;
        throw new HwidReaderError("timeout");
      }
      Object.assign(outcomes, parsed.slots);
      Object.assign(hwid, parsed.hwid);
      if (group.slots.some(slot => !Object.hasOwn(parsed.slots, slot)
        || ["error", "permission_denied", "invalid_value"].includes(outcomes[slot]))) {
        for (const slot of group.slots) if (!Object.hasOwn(parsed.slots, slot)) outcomes[slot] = "error";
        const readFailed = group.slots.some(slot => ["error", "permission_denied"].includes(parsed.slots[slot]));
        fail(readFailed ? "execution" : "invalid_output");
      }
    } catch (error) {
      // Only this attempt's handles may contribute diagnostic rows. A failed
      // group never becomes successful because another group returned data.
      if (error instanceof HwidReaderError && error.stdout) {
        try {
          const parsed = parseHwidOutput(error.stdout, group.slots);
          Object.assign(outcomes, parsed.slots);
          Object.assign(hwid, parsed.hwid);
        } catch { /* malformed diagnostic output is discarded */ }
      }
      const timedOut = expired || (error instanceof HwidReaderError && error.reason === "timeout")
        || performance.now() - groupStarted >= budget || performance.now() - started >= timeoutMs;
      for (const slot of group.slots) {
        if (outcomes[slot] === "not_collected") {
          outcomes[slot] = timedOut ? "timeout" : attempt.signal.aborted ? "cancelled" : "error";
        }
      }
      if (!attempt.signal.aborted) {
        const invalidOutput = error instanceof HwidVerificationError
          || (error instanceof HwidReaderError && error.reason === "output_limit");
        fail(timedOut ? "timeout" : invalidOutput ? "invalid_output" : "execution");
      }
    } finally {
      clearTimeout(timer);
      attempt.signal.removeEventListener("abort", abort);
      controller.abort();
      // Keep the worker slot until its actual process has closed. The work
      // deadline can expire before OS cleanup finishes; never overlap a
      // replacement reader with a process that is still terminating.
      if (handle) await handle.closed;
    }
  };

  const worker = async (): Promise<void> => {
    while (!attempt.signal.aborted && nextGroup < groups.length) {
      await runGroup(groups[nextGroup++]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(HWID_READER_CONCURRENCY, groups.length) }, () => worker()));
  } finally {
    clearTimeout(overallTimer);
    attempt.abort();
    await Promise.all(handles.map(handle => handle.closed));
    options.signal?.removeEventListener("abort", cancel);
  }
  if (options.signal?.aborted) return result("cancelled");
  if (failure) return result("failed", failure);
  if (performance.now() - started >= timeoutMs) return result("failed", "timeout");
  return Object.keys(hwid).length ? result("complete") : result("failed", "empty");
}

/** Only a completed, nonempty attempt may reach TPM signing and the ticket request. */
export async function collectHwid(
  requested: readonly string[] = HWID_CORE_SLOTS,
  options: HwidCollectionOptions = {},
): Promise<Record<string, string>> {
  const result = await collectHwidResult(requested, options);
  if (result.status !== "complete") {
    throw new HwidVerificationError(result.status === "cancelled" ? "cancelled"
      : result.status === "unsupported" ? "unsupported"
        : result.failure === "timeout" ? "timeout" : "unavailable");
  }
  assertHwidEvidence(result.hwid);
  return result.hwid;
}
