import { beforeEach, describe, expect, it, vi } from "vitest";
import { tpmBindingMessage } from "../shared/attestation.js";

// Every step the pass calls, recorded in call order. The services themselves
// have their own tests; this file pins the sequence that ties them together.
const calls = vi.hoisted(() => ({ log: [] as string[] }));
const steps = vi.hoisted(() => ({
  readInstallationMarker: vi.fn(),
  collectHwid: vi.fn(),
  collectTpmProof: vi.fn(),
  collectTpmAnchor: vi.fn(),
  enrolTpmAnchor: vi.fn(),
  loadBaseManifest: vi.fn(),
  mergeExpectedFiles: vi.fn(),
  readLauncherOverrides: vi.fn(),
  attestationChallengeRemainingMs: vi.fn(),
  buildAttestationResult: vi.fn(),
  measureInstallation: vi.fn(),
  requestAttestationChallenge: vi.fn(),
  applyGameplayPatchMode: vi.fn(),
  readCachedGameplayPatchMode: vi.fn(),
  recordGameplayPatchState: vi.fn(),
}));
vi.mock("../electron/services/installer.js", () => ({ readInstallationMarker: steps.readInstallationMarker }));
vi.mock("../electron/services/machine-identity.js", () => ({
  HWID_CORE_SLOTS: ["core-a", "core-b"], collectHwid: steps.collectHwid,
}));
vi.mock("../electron/services/tpm-identity.js", () => ({ collectTpmProof: steps.collectTpmProof }));
vi.mock("../electron/services/tpm-anchor.js", () => ({
  collectTpmAnchor: steps.collectTpmAnchor, enrolTpmAnchor: steps.enrolTpmAnchor,
}));
vi.mock("../electron/services/base-manifest.js", () => ({
  BASE_MANIFEST_URL: "https://manifest.test/base.json",
  loadBaseManifest: steps.loadBaseManifest,
  mergeExpectedFiles: steps.mergeExpectedFiles,
  readLauncherOverrides: steps.readLauncherOverrides,
}));
vi.mock("../electron/services/integrity-attestation.js", async (original) => ({
  ...await original<typeof import("../electron/services/integrity-attestation.js")>(),
  attestationChallengeRemainingMs: steps.attestationChallengeRemainingMs,
  buildAttestationResult: steps.buildAttestationResult,
  measureInstallation: steps.measureInstallation,
  requestAttestationChallenge: steps.requestAttestationChallenge,
}));
vi.mock("../electron/services/gameplay-patch.js", () => ({
  GAMEPLAY_MARKER_SHA256: "marker-sha", GAMEPLAY_PATCH_SHA256: "patch-sha",
  applyGameplayPatchMode: steps.applyGameplayPatchMode,
  readCachedGameplayPatchMode: steps.readCachedGameplayPatchMode,
  recordGameplayPatchState: steps.recordGameplayPatchState,
}));

import { AttestationUnavailableError } from "../electron/services/integrity-attestation.js";
import { attestInstallation, type LaunchAttestationContext } from "../electron/services/launch-attestation.js";
import { RUNTIME_CONFIGS } from "../electron/services/runtime-config.js";

const runtime = Object.values(RUNTIME_CONFIGS)[0];
const KEY = "player-key";
const challenge = (overrides: Record<string, unknown> = {}) => ({
  challengeId: "challenge-1", nonce: "nonce", policyVersion: "policy-1", packVersion: "pack-1",
  baseBuildId: "build-1", clientPatchMode: "patched", hwidSlots: ["slot-a", "slot-b"], ...overrides,
});
const hwid = { "slot-a": "A", "slot-b": "B" };
const measurement = { deviations: [], code: [{ path: "H1Z1.exe", sha256: "x" }] };

function context(overrides: Partial<LaunchAttestationContext> = {}): LaunchAttestationContext {
  return {
    installationRoot: "D:\\Games\\ROTK", userDataDirectory: "C:\\userData", launcherVersion: "2.0.50",
    bundled: { gameplayPatch: "bundled\\dinput8.dll", shim: "bundled\\steam_api64.dll",
      vivoxProxy: "bundled\\vivoxsdk_x64.dll", vivoxRuntime: "bundled\\vivoxsdk_x64_v5.dll" },
    readAssetState: async () => ({ assets: [{ installedFiles: [{ path: "a.pack2", size: 1, sha256: "s" }] }] }) as never,
    onMeasureProgress: vi.fn(),
    onMeasureEnd: vi.fn(() => { calls.log.push("measure-end"); }),
    ...overrides,
  };
}

/** A step that records its name when called and resolves with `value`. */
function step<T>(name: string, value: T) {
  return async () => { calls.log.push(name); return value; };
}

beforeEach(() => {
  calls.log.length = 0;
  for (const mock of Object.values(steps)) mock.mockReset();
  steps.readCachedGameplayPatchMode.mockImplementation(step("cached-mode", "patched"));
  steps.readInstallationMarker.mockImplementation(step("marker", { schemaVersion: 1, installId: "install" }));
  steps.requestAttestationChallenge.mockImplementation(step("challenge", challenge()));
  steps.applyGameplayPatchMode.mockImplementation(step("patch-applied", "up-to-date"));
  steps.recordGameplayPatchState.mockImplementation(step("patch-recorded", undefined));
  steps.loadBaseManifest.mockImplementation(step("manifest", { files: [{ path: "base.pack2", size: 2, sha256: "b" }] }));
  steps.readLauncherOverrides.mockImplementation(step("overrides", [{ path: "steam_api64.dll", size: 3, sha256: "o" }]));
  steps.mergeExpectedFiles.mockImplementation((...groups: unknown[]) => groups.flat());
  steps.collectHwid.mockImplementation(step("hwid", hwid));
  steps.measureInstallation.mockImplementation(step("measure", measurement));
  steps.attestationChallengeRemainingMs.mockReturnValue(120_000);
  steps.collectTpmProof.mockImplementation(step("tpm-proof", { signature: "proof" }));
  steps.collectTpmAnchor.mockImplementation(step("tpm-anchor", { proof: { signature: "anchor" } }));
  steps.enrolTpmAnchor.mockImplementation(step("enrol", { state: "activated" }));
  steps.buildAttestationResult.mockImplementation((...args: unknown[]) => { calls.log.push("block"); return { built: args }; });
});

describe("the attestation pass", () => {
  it("runs its steps in the order the server relies on", async () => {
    const outcome = await attestInstallation(KEY, runtime, context());
    expect(calls.log).toEqual([
      "cached-mode", "marker", "challenge", "patch-applied", "patch-recorded", "manifest", "overrides",
      // The fingerprint is read while the files are hashed, and used after.
      "hwid", "measure", "measure-end", "tpm-proof", "tpm-anchor", "enrol", "block",
    ]);
    expect(outcome).toMatchObject({ status: "attested", hwid, clientPatchMode: "patched", measuredCode: measurement.code });
    expect(steps.requestAttestationChallenge).toHaveBeenCalledExactlyOnceWith(KEY, runtime.attestationChallengeUrl, "2.0.50");
    expect(steps.loadBaseManifest).toHaveBeenCalledWith({
      url: "https://manifest.test/base.json", userDataDirectory: "C:\\userData", expectedBuildId: "build-1",
    });
  });

  it("measures the base tree, then the installed assets, then the launcher's own files, and reports undeclared files", async () => {
    await attestInstallation(KEY, runtime, context());
    expect(steps.mergeExpectedFiles).toHaveBeenCalledWith(
      [{ path: "base.pack2", size: 2, sha256: "b" }],
      [{ path: "a.pack2", size: 1, sha256: "s" }],
      [{ path: "steam_api64.dll", size: 3, sha256: "o" }],
    );
    expect(steps.measureInstallation).toHaveBeenCalledWith(expect.objectContaining({
      installationRoot: "D:\\Games\\ROTK", userDataDirectory: "C:\\userData", detectUnexpected: true,
    }));
  });

  it("applies the patch mode the signed challenge names, clean when it names none", async () => {
    await attestInstallation(KEY, runtime, context());
    expect(steps.applyGameplayPatchMode).toHaveBeenCalledWith("D:\\Games\\ROTK", "bundled\\dinput8.dll", "patched");
    expect(steps.recordGameplayPatchState).toHaveBeenCalledWith("C:\\userData",
      { mode: "patched", dllSha256: "patch-sha", markerSha256: "marker-sha", policyVersion: "policy-1" });
    expect(steps.readLauncherOverrides.mock.calls[0][0]).toEqual([
      { installPath: "steam_api64.dll", bundledPath: "bundled\\steam_api64.dll" },
      { installPath: "vivoxsdk_x64.dll", bundledPath: "bundled\\vivoxsdk_x64.dll" },
      { installPath: "vivoxsdk_x64_v5.dll", bundledPath: "bundled\\vivoxsdk_x64_v5.dll" },
      { installPath: "dinput8.dll", bundledPath: "bundled\\dinput8.dll" },
    ]);

    steps.requestAttestationChallenge.mockImplementation(step("challenge", challenge({ clientPatchMode: undefined })));
    const outcome = await attestInstallation(KEY, runtime, context());
    expect(steps.applyGameplayPatchMode).toHaveBeenLastCalledWith("D:\\Games\\ROTK", "bundled\\dinput8.dll", "clean");
    expect(steps.recordGameplayPatchState).toHaveBeenLastCalledWith("C:\\userData",
      { mode: "clean", dllSha256: null, markerSha256: null, policyVersion: "policy-1" });
    // dinput8.dll is attested only in patched mode.
    expect(steps.readLauncherOverrides.mock.calls[1][0]).toHaveLength(3);
    expect(outcome.clientPatchMode).toBe("clean");
  });

  it("reads only the fingerprint slots the challenge names, the core ones when it names none", async () => {
    await attestInstallation(KEY, runtime, context());
    expect(steps.collectHwid).toHaveBeenLastCalledWith(["slot-a", "slot-b"]);
    steps.requestAttestationChallenge.mockImplementation(step("challenge", challenge({ hwidSlots: undefined })));
    await attestInstallation(KEY, runtime, context());
    expect(steps.collectHwid).toHaveBeenLastCalledWith(["core-a", "core-b"]);
  });

  it("signs the final challenge together with the fingerprint the ticket will carry", async () => {
    const outcome = await attestInstallation(KEY, runtime, context());
    const message = tpmBindingMessage("challenge-1", hwid);
    expect(steps.collectTpmProof).toHaveBeenCalledExactlyOnceWith(message);
    expect(steps.collectTpmAnchor).toHaveBeenCalledExactlyOnceWith(message);
    // The very object that was signed, not a second read of the machine.
    expect(outcome).toMatchObject({ status: "attested" });
    expect((outcome as { hwid: unknown }).hwid).toBe(hwid);
    expect(steps.buildAttestationResult).toHaveBeenCalledWith(
      challenge(), measurement, "2.0.50", { signature: "proof" }, { signature: "anchor" });
  });

  it("returns only once the anchor enrolment has answered", async () => {
    let answer!: (value: { state: string }) => void;
    steps.enrolTpmAnchor.mockImplementation(() => { calls.log.push("enrol"); return new Promise((resolve) => { answer = resolve; }); });
    let settled = false;
    const pass = attestInstallation(KEY, runtime, context()).then((outcome) => { settled = true; return outcome; });
    await vi.waitFor(() => expect(calls.log).toContain("enrol"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(calls.log).not.toContain("block");
    answer({ state: "activated" });
    expect((await pass).status).toBe("attested");
    expect(steps.enrolTpmAnchor).toHaveBeenCalledWith(
      { beginUrl: runtime.tpmEnrolBeginUrl, completeUrl: runtime.tpmEnrolCompleteUrl }, KEY, "2.0.50",
      { proof: { signature: "anchor" } });
  });

  it("goes on without the TPM, and skips the enrolment when there is no anchor", async () => {
    steps.collectTpmProof.mockRejectedValue(new Error("no tpm"));
    steps.collectTpmAnchor.mockRejectedValue(new Error("no tpm"));
    const outcome = await attestInstallation(KEY, runtime, context());
    expect(outcome.status).toBe("attested");
    expect(steps.enrolTpmAnchor).not.toHaveBeenCalled();
    expect(steps.buildAttestationResult).toHaveBeenCalledWith(challenge(), measurement, "2.0.50", null, null);
  });
});

describe("renewing a challenge that hashing nearly outlived", () => {
  const renewed = (overrides: Record<string, unknown> = {}) => challenge({ challengeId: "challenge-2", nonce: "nonce-2", ...overrides });
  function secondChallenge(value: unknown): void {
    steps.requestAttestationChallenge
      .mockImplementationOnce(step("challenge", challenge()))
      .mockImplementationOnce(step("renewal", value));
  }

  it("keeps the challenge with a minute or more left, and renews it under a minute", async () => {
    steps.attestationChallengeRemainingMs.mockReturnValue(60_000);
    await attestInstallation(KEY, runtime, context());
    expect(steps.requestAttestationChallenge).toHaveBeenCalledOnce();

    steps.requestAttestationChallenge.mockClear();
    secondChallenge(renewed());
    steps.attestationChallengeRemainingMs.mockReturnValue(59_999);
    await attestInstallation(KEY, runtime, context());
    expect(steps.requestAttestationChallenge).toHaveBeenCalledTimes(2);
  });

  it("uses the new challenge for the TPM signature and the block, after the measurement", async () => {
    secondChallenge(renewed());
    steps.attestationChallengeRemainingMs.mockReturnValue(1_000);
    await attestInstallation(KEY, runtime, context());
    expect(calls.log.indexOf("renewal")).toBeGreaterThan(calls.log.indexOf("measure"));
    expect(calls.log.indexOf("renewal")).toBeLessThan(calls.log.indexOf("tpm-proof"));
    const message = tpmBindingMessage("challenge-2", hwid);
    expect(steps.collectTpmProof).toHaveBeenCalledWith(message);
    expect(steps.collectTpmAnchor).toHaveBeenCalledWith(message);
    expect(steps.buildAttestationResult.mock.calls[0][0]).toEqual(renewed());
    // One measurement serves both challenges.
    expect(steps.measureInstallation).toHaveBeenCalledOnce();
  });

  it.each([
    ["build", { baseBuildId: "build-2" }],
    ["policy", { policyVersion: "policy-2" }],
    ["pack", { packVersion: "pack-2" }],
    ["patch mode", { clientPatchMode: "clean" }],
    ["fingerprint slots", { hwidSlots: ["slot-a"] }],
  ])("keeps the first challenge when the new one names another %s", async (_name, difference) => {
    secondChallenge(renewed(difference));
    steps.attestationChallengeRemainingMs.mockReturnValue(1_000);
    await attestInstallation(KEY, runtime, context());
    expect(steps.collectTpmProof).toHaveBeenCalledWith(tpmBindingMessage("challenge-1", hwid));
    expect(steps.buildAttestationResult.mock.calls[0][0]).toEqual(challenge());
  });

  it("keeps the first challenge when the renewal request fails", async () => {
    steps.requestAttestationChallenge
      .mockImplementationOnce(step("challenge", challenge()))
      .mockRejectedValueOnce(new Error("offline"));
    steps.attestationChallengeRemainingMs.mockReturnValue(1_000);
    const outcome = await attestInstallation(KEY, runtime, context());
    expect(outcome.status).toBe("attested");
    expect(steps.buildAttestationResult.mock.calls[0][0]).toEqual(challenge());
  });
});

describe("a pass that cannot attest", () => {
  it("does not ask the server for anything without an installation or its marker", async () => {
    expect(await attestInstallation(KEY, runtime, context({ installationRoot: null })))
      .toEqual({ status: "not-applicable", clientPatchMode: "patched" });
    steps.readInstallationMarker.mockResolvedValue(null);
    expect(await attestInstallation(KEY, runtime, context()))
      .toEqual({ status: "not-applicable", clientPatchMode: "patched" });
    expect(steps.requestAttestationChallenge).not.toHaveBeenCalled();
    expect(steps.applyGameplayPatchMode).not.toHaveBeenCalled();
  });

  it("starts on the patched mode when no earlier launch recorded one", async () => {
    steps.readCachedGameplayPatchMode.mockResolvedValue(null);
    expect(await attestInstallation(KEY, runtime, context({ installationRoot: null })))
      .toEqual({ status: "not-applicable", clientPatchMode: "patched" });
  });

  it("hands a version refusal to the caller untouched", async () => {
    const refusal = Object.assign(new Error("update"), { code: "launcher_update_required" });
    steps.requestAttestationChallenge.mockRejectedValue(refusal);
    const ctx = context();
    await expect(attestInstallation(KEY, runtime, ctx)).rejects.toBe(refusal);
    expect(ctx.onMeasureEnd).toHaveBeenCalledOnce();
    expect(steps.applyGameplayPatchMode).not.toHaveBeenCalled();
  });

  it("falls back to the last known patch mode when the server publishes no policy", async () => {
    steps.readCachedGameplayPatchMode.mockResolvedValue("clean");
    steps.requestAttestationChallenge.mockRejectedValue(new AttestationUnavailableError("no policy", true));
    expect(await attestInstallation(KEY, runtime, context())).toEqual({ status: "not-applicable", clientPatchMode: "clean" });
    expect(steps.applyGameplayPatchMode).toHaveBeenCalledExactlyOnceWith("D:\\Games\\ROTK", "bundled\\dinput8.dll", "clean");
  });

  it("reports why it could not run, and never exempts the launch by itself", async () => {
    steps.measureInstallation.mockRejectedValue(new Error("Unable to read the game files"));
    const ctx = context();
    expect(await attestInstallation(KEY, runtime, ctx)).toEqual({
      status: "unavailable", reason: "Unable to read the game files.", clientPatchMode: "patched",
    });
    expect(ctx.onMeasureEnd).toHaveBeenCalledOnce();
    // The mode of the last launch is put back; the signed one could not be honoured.
    expect(steps.applyGameplayPatchMode).toHaveBeenLastCalledWith("D:\\Games\\ROTK", "bundled\\dinput8.dll", "patched");
    expect(steps.buildAttestationResult).not.toHaveBeenCalled();
  });
});
