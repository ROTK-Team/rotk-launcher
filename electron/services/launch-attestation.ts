import type { RuntimeConfig } from "./runtime-config.js";
import type { AssetSyncService } from "./asset-sync.js";
import type { AttestationOutcome } from "./game-launcher.js";
import { readInstallationMarker } from "./installer.js";
import { HWID_CORE_SLOTS, collectHwid } from "./machine-identity.js";
import { collectTpmProof } from "./tpm-identity.js";
import { collectTpmAnchor, enrolTpmAnchor } from "./tpm-anchor.js";
import { tpmBindingMessage } from "../../shared/attestation.js";
import {
  BASE_MANIFEST_URL,
  loadBaseManifest,
  mergeExpectedFiles,
  readLauncherOverrides,
} from "./base-manifest.js";
import {
  AttestationUnavailableError,
  attestationChallengeRemainingMs,
  buildAttestationResult,
  measureInstallation,
  requestAttestationChallenge,
  type AttestationProgress,
} from "./integrity-attestation.js";
import {
  GAMEPLAY_MARKER_SHA256,
  GAMEPLAY_PATCH_SHA256,
  applyGameplayPatchMode,
  readCachedGameplayPatchMode,
  recordGameplayPatchState,
  type GameplayPatchMode,
} from "./gameplay-patch.js";

/**
 * What the pass reads from the launcher process. It lived in main.ts and read
 * these from its module scope; they are passed in so the sequence below can be
 * run by a test.
 */
export interface LaunchAttestationContext {
  /** Root recorded in the configuration; null before any installation. */
  installationRoot: string | null;
  userDataDirectory: string;
  launcherVersion: string;
  /** The artifacts this launcher ships and attests in place of the vanilla files. */
  bundled: { gameplayPatch: string; shim: string; vivoxProxy: string; vivoxRuntime: string };
  readAssetState(): ReturnType<AssetSyncService["readState"]>;
  /** Hashing progress, "done" included; the caller decides what to show. */
  onMeasureProgress(progress: AttestationProgress): void;
  /** The measurement is over, or the pass failed: nothing left to show. */
  onMeasureEnd(): void;
}

/**
 * Runs one integrity attestation pass and returns the block the launch ticket
 * request carries. Returns null only when attestation genuinely cannot run
 * (no policy published, manifest unreachable and never cached) — it is the
 * backend, not the launcher, that decides whether a null is acceptable.
 *
 * A tampered installation still attests: the deviations are reported and the
 * evidence will not match, so the rejection is logged for the admin studio
 * instead of being silently hidden by the client.
 */
// Ask for a new challenge when less than this is left after hashing.
const CHALLENGE_MARGIN_MS = 60_000;

export async function attestInstallation(
  playerKey: string,
  runtime: RuntimeConfig,
  context: LaunchAttestationContext,
): Promise<AttestationOutcome> {
  const root = context.installationRoot;
  const userDataDirectory = context.userDataDirectory;
  const launcherVersion = context.launcherVersion;
  // A server that does not run attestation (no policy yet, development
  // backend) gets the last mode this player was told to use; a fresh machine
  // starts on the shipped default. Production always uses the signed
  // challenge directive below.
  const fallbackMode: GameplayPatchMode =
    await readCachedGameplayPatchMode(userDataDirectory) ?? "patched";
  if (!root) return { status: "not-applicable", clientPatchMode: fallbackMode };
  try {
    const marker = await readInstallationMarker(root);
    if (!marker) return { status: "not-applicable", clientPatchMode: fallbackMode };

    let challenge = await requestAttestationChallenge(
      playerKey,
      runtime.attestationChallengeUrl,
      launcherVersion,
    );
    // The signed challenge names the client-patch mode this launch must use.
    // A server that predates the field expects a clean tree, so the safe
    // default is "clean" rather than silently keeping a local patch.
    const clientPatchMode: GameplayPatchMode = challenge.clientPatchMode ?? "clean";
    await applyGameplayPatchMode(
      root,
      context.bundled.gameplayPatch,
      clientPatchMode,
    );
    await recordGameplayPatchState(userDataDirectory, {
      mode: clientPatchMode,
      dllSha256: clientPatchMode === "patched" ? GAMEPLAY_PATCH_SHA256 : null,
      markerSha256: clientPatchMode === "patched" ? GAMEPLAY_MARKER_SHA256 : null,
      policyVersion: challenge.policyVersion,
    });
    const baseManifest = await loadBaseManifest({
      url: BASE_MANIFEST_URL,
      userDataDirectory,
      expectedBuildId: challenge.baseBuildId,
    });
    const assetState = await context.readAssetState().catch(() => null);
    const installedAssets = (assetState?.assets ?? []).flatMap((asset) =>
      asset.installedFiles.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })));
    // Files the launcher deliberately replaces or adds: expect its artifacts,
    // not the vanilla hashes, so they stay attested instead of excluded. Keep
    // in sync with ATTESTATION_OVERRIDE_PATHS and the policy publisher's
    // --override flags — a missing entry here flags every honest install.
    const overrides = await readLauncherOverrides([
      { installPath: "steam_api64.dll", bundledPath: context.bundled.shim },
      { installPath: "vivoxsdk_x64.dll", bundledPath: context.bundled.vivoxProxy },
      { installPath: "vivoxsdk_x64_v5.dll", bundledPath: context.bundled.vivoxRuntime },
      ...(clientPatchMode === "patched"
        ? [{ installPath: "dinput8.dll", bundledPath: context.bundled.gameplayPatch }]
        : []),
    ]);

    // The fingerprint only needs the slots the challenge names: read it while
    // the files are hashed instead of after.
    const hwidSlots = challenge.hwidSlots ?? HWID_CORE_SLOTS;
    const hwidPromise = collectHwid(hwidSlots).catch(() => ({}));
    const measurement = await measureInstallation({
      installationRoot: root,
      userDataDirectory,
      expected: mergeExpectedFiles(baseManifest.files, installedAssets, overrides),
      // Report undeclared .pack2/.dll/.exe dropped into the game tree. Costs
      // one directory walk; the per-file hashing dominates anyway.
      detectUnexpected: true,
      onProgress: context.onMeasureProgress,
    });
    context.onMeasureEnd();
    if (measurement.deviations.length > 0) {
      console.warn(
        `Integrity attestation found ${measurement.deviations.length} deviation(s); reporting them.`,
      );
    }
    // A first launch hashes the whole client and can outlive the challenge.
    // The measurement does not depend on it, so a fresh one with the same
    // build, policy, pack, patch mode and slots can be used as is. A failed
    // renewal keeps the old one, which the server may still accept.
    if (attestationChallengeRemainingMs(challenge) < CHALLENGE_MARGIN_MS) {
      const fresh = await requestAttestationChallenge(playerKey, runtime.attestationChallengeUrl, launcherVersion)
        .catch(() => challenge);
      if (
        fresh.baseBuildId === challenge.baseBuildId
        && fresh.policyVersion === challenge.policyVersion
        && fresh.packVersion === challenge.packVersion
        && (fresh.clientPatchMode ?? "clean") === clientPatchMode
        && JSON.stringify(fresh.hwidSlots ?? HWID_CORE_SLOTS) === JSON.stringify(hwidSlots)
      ) {
        challenge = fresh;
      }
    }
    // The fingerprint this launch was asked for (#320 §B): the slots the signed
    // challenge names, or the core five for a server that names none.
    const hwid = await hwidPromise;
    // Sign with the TPM-backed key when the machine has one; null when it does
    // not, and the launch proceeds without it. The message binds the
    // (single-use) challengeId to the fingerprint exactly as the ticket will
    // carry it (#320 §C): neither can be swapped under the other, and the
    // single-use challenge stops replay. The server decides (behind its own
    // flag) whether a missing proof is acceptable.
    const bindingMessage = tpmBindingMessage(challenge.challengeId, hwid);
    // Both TPM steps sign the same message; run them side by side.
    const [tpmProof, anchor] = await Promise.all([
      collectTpmProof(bindingMessage).catch(() => null),
      collectTpmAnchor(bindingMessage).catch(() => null),
    ]);
    // Level-2 anchor (#320 §A): the TPM identity key signs the same message,
    // and the server is told which endorsement key it lives under — a
    // credential activation the first time, one confirming request after.
    // Observe only: a machine without it launches exactly as before.
    if (anchor !== null) {
      const enrolment = await enrolTpmAnchor(
        { beginUrl: runtime.tpmEnrolBeginUrl, completeUrl: runtime.tpmEnrolCompleteUrl },
        playerKey,
        launcherVersion,
        anchor,
      ).catch(() => null);
      if (enrolment !== null && enrolment.state !== "activated") {
        console.warn("TPM anchor not activated", enrolment);
      }
    }
    return {
      status: "attested",
      block: buildAttestationResult(challenge, measurement, launcherVersion, tpmProof, anchor?.proof ?? null),
      hwid,
      clientPatchMode,
      measuredCode: measurement.code,
    };
  } catch (error) {
    context.onMeasureEnd();
    // A minimum-version rejection is authoritative and must reach the Play
    // handler so it can lock the button and surface the mandatory updater UI.
    if ((error as { code?: string })?.code === "launcher_update_required") {
      throw error;
    }
    // No policy published / attestation unconfigured: it does not apply, and
    // the launch proceeds silently exactly as before enforcement existed.
    if (error instanceof AttestationUnavailableError && error.notApplicable) {
      await applyGameplayPatchMode(
        root,
        context.bundled.gameplayPatch,
        fallbackMode,
      ).catch(() => undefined);
      return { status: "not-applicable", clientPatchMode: fallbackMode };
    }
    // A challenge or manifest we could not obtain, or files we could not read:
    // attestation should have run and did not. Carry the reason so a launch the
    // backend then blocks can say why, instead of blaming the launcher version.
    const reason = error instanceof Error && error.message
      ? error.message.replace(/[.]?\s*$/, ".")
      : "the integrity service could not be reached.";
    console.warn("Integrity attestation could not complete", { message: reason });
    await applyGameplayPatchMode(
      root,
      context.bundled.gameplayPatch,
      fallbackMode,
    ).catch(() => undefined);
    return { status: "unavailable", reason, clientPatchMode: fallbackMode };
  }
}
