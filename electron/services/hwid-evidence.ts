/** Local input checks only; the account service must independently enforce its policy. */
export const MAX_HWID_SLOTS = 40;
export const MAX_HWID_VALUE_LENGTH = 1024;
const HWID_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "", "0", "none", "n/a", "na", "null", "default string", "to be filled by o.e.m.",
  "system serial number", "not applicable", "not available", "无", "00000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff", "00000000-0000-0000-0000-000000000000",
]);

export class HwidVerificationError extends Error {
  readonly code = "hwid_verification_failed";

  constructor(readonly reason: "timeout" | "cancelled" | "unsupported" | "unavailable" | "invalid") {
    super(reason === "timeout"
      ? "Hardware verification timed out. Close busy applications and try again."
      : reason === "cancelled"
        ? "Hardware verification was cancelled. Try again before playing."
        : reason === "unsupported"
          ? "Hardware verification is not supported by this launcher on this system. Contact ROTK support."
          : "Hardware verification could not complete. Try again; if the problem persists, contact ROTK support.");
    this.name = "HwidVerificationError";
  }
}

function isHwidText(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_HWID_VALUE_LENGTH
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isHwidPlaceholder(value: unknown): boolean {
  return isHwidText(value) && HWID_PLACEHOLDERS.has(value.trim().replace(/\s+/g, " ").toLowerCase());
}

export function isUsableHwidValue(value: unknown): value is string {
  return isHwidText(value) && !isHwidPlaceholder(value);
}

/** Validate without changing bytes: a TPM proof may already cover this exact vector. */
export function assertHwidEvidence(value: unknown): asserts value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new HwidVerificationError("invalid");
  }
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  if (entries.length === 0 || entries.length > MAX_HWID_SLOTS
    || entries.some(([slot, descriptor]) => !/^[a-z0-9_]{1,40}$/.test(slot)
      || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || !isUsableHwidValue(descriptor.value))) {
    throw new HwidVerificationError("invalid");
  }
}
