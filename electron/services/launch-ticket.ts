import { isValidLaunchTicket } from "../../shared/launch-ticket.js";
import { isValidPlayerKey, normalizePlayerKey } from "../../shared/player-key.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STEAM_ID_PATTERN = /^\d{17}$/;
const DECIMAL_ID_PATTERN = /^[1-9]\d{0,18}$/;
const MAX_SIGNED_63_BIT = 9_223_372_036_854_775_807n;
const MINIMUM_TICKET_LIFETIME_MS = 10_000;
const MAXIMUM_SERVER_TICKET_LIFETIME_MS = 10 * 60_000;

export interface LaunchTicketIdentity {
  readonly ticket: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Monotonic receipt time; never derived from the workstation wall clock. */
  readonly receivedAtMonotonicMs: number;
  /** Conservative remaining lifetime at receipt, based on authority timestamps. */
  readonly initialRemainingLifetimeMs: number;
  readonly rotkId: string;
  readonly gameAccountGuid: string;
  readonly steamId: string;
  readonly displayName: string;
}

interface TicketRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Integrity attestation block (see integrity-attestation.ts). Optional while
   * the backend runs in observation mode; required once enforcement is on.
   */
  attestation?: unknown;
  /**
   * Set when attestation should have run but could not (service unreachable,
   * files unreadable). No block is sent; if enforcement then refuses the
   * launch, this reason is surfaced instead of the misleading "update the
   * launcher" — the launch failed because the files could not be verified, not
   * because the launcher is old.
   */
  attestationUnavailableReason?: string;
  /**
   * This launcher's version, sent top-level so the server's update gate can act
   * even when no attestation block is present. The server refuses an
   * under-minimum version with launcher_update_required.
   */
  launcherVersion?: string;
  /**
   * The raw hardware fingerprint (see machine-identity.ts). The server
   * keyed-hashes each component and stores only digests; the launcher holds no
   * hashing key and sends the raw values, exactly like the address it never
   * sees hashed.
   */
  hwid?: Record<string, string>;
}

function validateEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error("Invalid ROTK launch ticket endpoint");
  }
  return endpoint;
}

export function assertLaunchTicketFresh(
  identity: Pick<
    LaunchTicketIdentity,
    "receivedAtMonotonicMs" | "initialRemainingLifetimeMs"
  >,
  minimumLifetimeMs = MINIMUM_TICKET_LIFETIME_MS,
  nowMonotonicMs = performance.now(),
): void {
  if (
    !Number.isFinite(minimumLifetimeMs)
    || minimumLifetimeMs < 0
    || minimumLifetimeMs > MAXIMUM_SERVER_TICKET_LIFETIME_MS
    || !Number.isFinite(nowMonotonicMs)
    || !Number.isFinite(identity.receivedAtMonotonicMs)
    || !Number.isFinite(identity.initialRemainingLifetimeMs)
    || identity.initialRemainingLifetimeMs <= 0
    || identity.initialRemainingLifetimeMs > MAXIMUM_SERVER_TICKET_LIFETIME_MS
  ) {
    throw new Error("Invalid ROTK launch ticket freshness check");
  }
  const elapsedSinceReceiptMs = Math.max(
    0,
    nowMonotonicMs - identity.receivedAtMonotonicMs,
  );
  if (identity.initialRemainingLifetimeMs - elapsedSinceReceiptMs <= minimumLifetimeMs) {
    throw new Error("The ROTK launch ticket expires too soon");
  }
}

function parseCanonicalAuthorityTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : Number.NaN;
}

interface TicketResponseTiming {
  readonly requestStartedAtMonotonicMs: number;
  readonly receivedAtMonotonicMs: number;
}

function parseTicketResponse(
  value: unknown,
  timing: TicketResponseTiming = {
    requestStartedAtMonotonicMs: performance.now(),
    receivedAtMonotonicMs: performance.now(),
  },
): LaunchTicketIdentity {
  if (!value || typeof value !== "object") throw new Error("Invalid response from the ROTK account service");
  const response = value as Record<string, unknown>;
  const issuedAt = typeof response.issuedAt === "string" ? response.issuedAt : "";
  const expiresAt = typeof response.expiresAt === "string" ? response.expiresAt : "";
  const displayName = typeof response.displayName === "string" ? response.displayName.trim() : "";
  const gameAccountGuid = typeof response.gameAccountGuid === "string" ? response.gameAccountGuid : "";
  const issuedAtMs = parseCanonicalAuthorityTimestamp(issuedAt);
  const expiresAtMs = parseCanonicalAuthorityTimestamp(expiresAt);
  const requestElapsedMs = timing.receivedAtMonotonicMs - timing.requestStartedAtMonotonicMs;
  const serverTicketLifetimeMs = expiresAtMs - issuedAtMs;
  if (
    response.ok !== true
    || !isValidLaunchTicket(response.ticket)
    || !UUID_V4_PATTERN.test(typeof response.rotkId === "string" ? response.rotkId : "")
    || !DECIMAL_ID_PATTERN.test(gameAccountGuid)
    || BigInt(gameAccountGuid) > MAX_SIGNED_63_BIT
    || !STEAM_ID_PATTERN.test(typeof response.steamId === "string" ? response.steamId : "")
    || displayName.length < 1
    || displayName.length > 32
    || /[\u0000-\u001f\u007f]/u.test(displayName)
    || !Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || !Number.isFinite(timing.requestStartedAtMonotonicMs)
    || !Number.isFinite(timing.receivedAtMonotonicMs)
    || requestElapsedMs < 0
    || serverTicketLifetimeMs <= 0
    || serverTicketLifetimeMs > MAXIMUM_SERVER_TICKET_LIFETIME_MS
  ) {
    throw new Error("Invalid response from the ROTK account service");
  }
  // The authority-issued interval is independent from the workstation clock.
  // Subtracting the complete HTTPS round trip is deliberately conservative:
  // issuance happens during that interval, never before it. The game server
  // still enforces expiry, one-time consumption and account binding.
  const identity: LaunchTicketIdentity = Object.freeze({
    ticket: response.ticket,
    issuedAt,
    expiresAt,
    receivedAtMonotonicMs: timing.receivedAtMonotonicMs,
    initialRemainingLifetimeMs: serverTicketLifetimeMs - requestElapsedMs,
    rotkId: response.rotkId as string,
    gameAccountGuid,
    steamId: response.steamId as string,
    displayName,
  });
  assertLaunchTicketFresh(identity, MINIMUM_TICKET_LIFETIME_MS, timing.receivedAtMonotonicMs);
  return identity;
}
/** The server keeps an exact list of accepted launcher versions and names the latest. */
export function launcherUpdateRequiredError(payload: unknown): Error {
  const required = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).requiredVersion
    : null;
  const version = typeof required === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(required) ? required : null;
  const error = new Error(
    "This launcher version is too old to verify the game files. Update the launcher."
      + (version ? ` Required version: ${version}.` : ""),
  );
  // Tagged so the launch flow can make the update mandatory (block Play,
  // trigger the updater) rather than only showing the message.
  (error as { code?: string }).code = "launcher_update_required";
  return error;
}

function serviceError(status: number, value: unknown, attestationUnavailableReason?: string): Error {
  const payload = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const errorCode = payload?.error ?? null;
  // The server also answers a missing attestation with launcher_update_required
  // (failureCode missing_attestation). Only a real version refusal is an update.
  const missingAttestation = payload?.failureCode === "missing_attestation";
  if (errorCode === "launcher_update_required" && !(missingAttestation && attestationUnavailableReason)) {
    return launcherUpdateRequiredError(payload);
  }
  // Enforcement refuses either an installation that failed verification, or one
  // that submitted no attestation at all. When we already know the launcher
  // could not run attestation, that second case is not a tamper and not an old
  // launcher: say so, so the player checks their connection instead of chasing
  // a phantom update or a "verify files" that will not help.
  if ((errorCode === "attestation_failed" || errorCode === "launcher_update_required") && attestationUnavailableReason) {
    return new Error(
      `ROTK could not verify your game files: ${attestationUnavailableReason} `
      + "Check your connection and try again.",
    );
  }
  if (errorCode === "attestation_failed") {
    return new Error(
      "The game files do not match the official ROTK installation. Use Verify files, then try again.",
    );
  }
  if (errorCode === "account_banned") {
    const expiresAt = typeof payload?.expiresAt === "string" ? payload.expiresAt : null;
    const reason = typeof payload?.reason === "string" && payload.reason ? ` Reason: ${payload.reason}` : "";
    return new Error(
      expiresAt
        ? `This ROTK account is suspended until ${new Date(expiresAt).toLocaleString()}.${reason}`
        : `This ROTK account is permanently banned.${reason}`,
    );
  }
  // The account exists and the key is good, but the service holds no game
  // identity to put in a ticket. Naming that is the difference between a player
  // who knows to finish signing in and one who reinstalls the game twice.
  if (errorCode === "account_not_ready") {
    return new Error(
      "This ROTK account is not ready to play yet. Sign in on the ROTK website, then try again.",
    );
  }
  if (status === 401 || errorCode === "invalid_credentials") {
    return new Error("The ROTK launcher key was rejected");
  }
  if (status === 429 || errorCode === "rate_limited") {
    return new Error("Too many ROTK authentication attempts. Wait a moment and try again");
  }
  if (status === 503 || errorCode === "service_unavailable") {
    return new Error("The ROTK account service is temporarily unavailable");
  }
  return new Error("The ROTK account service refused the launch request");
}

export async function createLaunchTicket(
  playerKey: unknown,
  endpointValue: string,
  options: TicketRequestOptions = {},
): Promise<LaunchTicketIdentity> {
  if (!isValidPlayerKey(playerKey)) throw new Error("Invalid ROTK player key");
  const endpoint = validateEndpoint(endpointValue);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestStartedAtMonotonicMs = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          launcherKey: normalizePlayerKey(playerKey),
          ...(options.launcherVersion ? { launcherVersion: options.launcherVersion } : {}),
          ...(options.hwid && Object.keys(options.hwid).length > 0 ? { hwid: options.hwid } : {}),
          ...(options.attestation ? { attestation: options.attestation } : {}),
        }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      // Keep the network cause (timeout, DNS, TLS...) visible for support, as a
      // code: the raw message is English and may be anything.
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      const cause = timedOut
        ? "timeout"
        : (error as Error)?.name === "AbortError"
          ? "cancelled"
          : typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "";
      throw new Error(`Unable to reach the ROTK account service${cause ? ` (${cause})` : ""}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Invalid response from the ROTK account service (HTTP ${response.status})`);
    }
    if (!response.ok) throw serviceError(response.status, payload, options.attestationUnavailableReason);
    return parseTicketResponse(payload, {
      requestStartedAtMonotonicMs,
      receivedAtMonotonicMs: performance.now(),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const launchTicketInternals = {
  parseTicketResponse,
  validateEndpoint,
};
