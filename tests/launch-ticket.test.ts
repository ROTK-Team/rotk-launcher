import { describe, expect, it, vi } from "vitest";
import {
  assertLaunchTicketFresh,
  createLaunchTicket,
  launchTicketInternals,
} from "../electron/services/launch-ticket.js";

const launcherKey = "0123456789abcdef0123456789abcdef";
const endpoint = "https://accounts.rotk.app/createLaunchTicket";
const authorityIssuedAtMs = Date.now();

function validTicketResponse(lifetimeMs = 120_000) {
  return {
    ok: true,
    ticket: "T".repeat(43),
    issuedAt: new Date(authorityIssuedAtMs).toISOString(),
    expiresAt: new Date(authorityIssuedAtMs + lifetimeMs).toISOString(),
    rotkId: "123e4567-e89b-42d3-a456-426614174000",
    gameAccountGuid: "9223372036854775807",
    steamId: "76561198000000001",
    displayName: "ROTK Player",
  };
}

const validResponse = validTicketResponse();
// Stand-in for the single-use block integrity-attestation.ts builds.
const attestation = { challengeId: "challenge-1" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ROTK launch ticket client", () => {
  it("sends the durable key only in the HTTPS JSON body and validates the identity", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(input.toString()).toBe(endpoint);
      expect(input.toString()).not.toContain(launcherKey);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ launcherKey }));
      return jsonResponse(validResponse);
    }) as typeof fetch;

    const identity = await createLaunchTicket(launcherKey, endpoint, { fetchImpl });
    expect(identity).toMatchObject({
      ticket: validResponse.ticket,
      issuedAt: validResponse.issuedAt,
      expiresAt: validResponse.expiresAt,
      rotkId: validResponse.rotkId,
      gameAccountGuid: validResponse.gameAccountGuid,
      steamId: validResponse.steamId,
      displayName: validResponse.displayName,
    });
    expect(identity.receivedAtMonotonicMs).toBeGreaterThanOrEqual(0);
    expect(identity.initialRemainingLifetimeMs).toBeGreaterThan(110_000);
    expect(identity.initialRemainingLifetimeMs).toBeLessThanOrEqual(120_000);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends the launcher version and HWID vector when provided", async () => {
    const hwid = { machine_guid: "mg-1", smbios_uuid: "sm-2", disk_serial: "dk-4" };
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ launcherKey, launcherVersion: "1.4.0", hwid });
      return jsonResponse(validResponse);
    }) as typeof fetch;
    await createLaunchTicket(launcherKey, endpoint, { fetchImpl, launcherVersion: "1.4.0", hwid });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("omits an empty HWID vector rather than sending an empty object", async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ launcherKey, launcherVersion: "1.4.0" });
      return jsonResponse(validResponse);
    }) as typeof fetch;
    await createLaunchTicket(launcherKey, endpoint, { fetchImpl, launcherVersion: "1.4.0", hwid: {} });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("tags the update-required refusal so the launch flow can make it mandatory", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "launcher_update_required" }, 403)) as typeof fetch;
    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toMatchObject({ code: "launcher_update_required" });
  });

  it("does not reject a valid authority window when the workstation wall clock is wrong", async () => {
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(authorityIssuedAtMs + 24 * 60 * 60_000);
    const fetchImpl = vi.fn(async () => jsonResponse(validResponse)) as typeof fetch;
    try {
      await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
        .resolves.toMatchObject({ ticket: validResponse.ticket });
    } finally {
      wallClock.mockRestore();
    }
  });

  it("tracks freshness from authority lifetime plus monotonic elapsed time", () => {
    const identity = launchTicketInternals.parseTicketResponse(validResponse, {
      requestStartedAtMonotonicMs: 1_000,
      receivedAtMonotonicMs: 1_100,
    });
    expect(identity.initialRemainingLifetimeMs).toBe(119_900);
    expect(() => assertLaunchTicketFresh(identity, 10_000, 110_999)).not.toThrow();
    expect(() => assertLaunchTicketFresh(identity, 10_000, 111_000))
      .toThrow("The ROTK launch ticket expires too soon");
  });

  it("fails closed when the key is rejected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: false,
      error: "invalid_credentials",
      message: "Invalid launcher key",
    }, 401)) as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toThrow("The ROTK launcher key was rejected");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("aborts a stalled response body without retrying after HTTP headers", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      }));
    }) as typeof fetch;
    try {
      const result = expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl, timeoutMs: 100 }))
        .rejects.toThrow("Unable to reach the ROTK account service (timeout)");
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a header timeout once and cleans up both attempt timers", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    try {
      const result = expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl, timeoutMs: 100 }))
        .rejects.toThrow("Unable to reach the ROTK account service (timeout)");
      await vi.advanceTimersByTimeAsync(550);
      await result;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose arbitrary transport messages or retry invalid JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 502 })) as typeof fetch;
    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toThrow("Invalid response from the ROTK account service (HTTP 502)");
    expect(fetchImpl).toHaveBeenCalledOnce();

    const failingFetch = vi.fn(async () => { throw new Error(`request failed: ${launcherKey}`); }) as typeof fetch;
    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl: failingFetch }))
      .rejects.toThrow(/^Unable to reach the ROTK account service \(NETWORK_ERROR\)$/);
  });

  it("retries one network failure before surfacing the account-service error", async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return jsonResponse(validResponse);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .resolves.toMatchObject({ ticket: validResponse.ticket });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the network cause when the account service cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toThrow("Unable to reach the ROTK account service (ENOTFOUND)");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not replay an attestation after a header timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    try {
      const result = expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl, timeoutMs: 100, attestation }))
        .rejects.toThrow("Unable to reach the ROTK account service (timeout)");
      await vi.advanceTimersByTimeAsync(550);
      await result;
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET"])("does not replay an attestation after %s", async (code) => {
    // Node reports a reset during the TLS handshake and one after the request
    // was written with the same ECONNRESET: neither proves the challenge unused.
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code } });
    }) as unknown as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl, attestation }))
      .rejects.toThrow(`Unable to reach the ROTK account service (${code})`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["ENOTFOUND", "ECONNREFUSED"])("retries an attestation once after %s, which proves it was never sent", async (code) => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw Object.assign(new Error("fetch failed"), { cause: { code } });
      }
      return jsonResponse(validResponse);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl, attestation }))
      .resolves.toMatchObject({ ticket: validResponse.ticket });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names an account the service holds no game identity for", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "account_not_ready" }, 403)) as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toThrow("This ROTK account is not ready to play yet");
  });

  it("blames verification, not the launcher version, when attestation could not run", async () => {
    // Enforcement answers a missing attestation with launcher_update_required.
    // When the launcher already knows it could not verify (service unreachable),
    // the player must be pointed at their connection, not a phantom update.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "launcher_update_required", failureCode: "missing_attestation" }, 403),
    ) as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, {
      fetchImpl,
      attestationUnavailableReason: "the ROTK integrity service could not be reached.",
    })).rejects.toThrow(/could not verify your game files.*could not be reached/s);
  });

  it("keeps the update message when attestation actually ran and the launcher is old", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "launcher_update_required", failureCode: "launcher_update_required" }, 403),
    ) as typeof fetch;

    // No unavailable reason: the block was sent and the server judged the
    // version too old, so the update message is the right one.
    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toThrow("This launcher version is too old");
  });

  it("rejects malformed identity data even after HTTP 200", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ...validResponse,
      steamId: "not-a-steam-id",
    })) as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toThrow("Invalid response from the ROTK account service");
  });

  it("rejects a server-issued ticket window with less than ten seconds", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validTicketResponse(5_000))) as typeof fetch;

    await expect(createLaunchTicket(launcherKey, endpoint, { fetchImpl }))
      .rejects.toThrow("The ROTK launch ticket expires too soon");
  });

  it("rejects malformed or implausibly long authority windows", () => {
    expect(() => launchTicketInternals.parseTicketResponse({
      ...validResponse,
      issuedAt: "not-a-date",
    })).toThrow("Invalid response from the ROTK account service");
    expect(() => launchTicketInternals.parseTicketResponse({
      ...validResponse,
      issuedAt: validResponse.issuedAt.replace("Z", "+00:00"),
    })).toThrow("Invalid response from the ROTK account service");
    expect(() => launchTicketInternals.parseTicketResponse(validTicketResponse(11 * 60_000)))
      .toThrow("Invalid response from the ROTK account service");
  });

  it("requires an HTTPS endpoint without query parameters", async () => {
    await expect(createLaunchTicket(launcherKey, `${endpoint}?key=bad`))
      .rejects.toThrow("Invalid ROTK launch ticket endpoint");
  });
});
