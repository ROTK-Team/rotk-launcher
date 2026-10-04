/**
 * Launcher integrity attestation — canonical encodings and signature verification.
 *
 * The launcher is open source and runs on the player's machine, so nothing here
 * is a secret. What the protocol buys us is:
 *
 *  - replay resistance: every attestation answers a fresh single-use server nonce;
 *  - manifest authenticity: manifests are Ed25519-signed by the ROTK release key,
 *    so a hostile mirror cannot redefine what "unmodified files" means;
 *  - a server-side verdict: the server compares the evidence against its own
 *    expected root, so recompiling the launcher to claim success achieves nothing.
 *
 * What it cannot buy (client-side hashing on hostile hardware): a determined
 * attacker may keep pristine copies and hash those while the game loads modified
 * files. See docs/SPEC_LAUNCHER_ATTESTATION.md §2.
 *
 * IMPORTANT: the canonical encodings below are mirrored byte-for-byte by the
 * backend module `rotk-web/functions/attestation.js`. The shared test vectors in
 * ATTESTATION_TEST_VECTORS must produce identical digests on both sides — any
 * change here is a protocol break requiring a coordinated release.
 */

import { createHash, verify as verifySignature } from "node:crypto";

export const ATTESTATION_PROTOCOL_VERSION = 1;

/** Domain separation tags. Never reuse a digest across contexts. */
export const MANIFEST_ROOT_DOMAIN = "rotk-manifest-v1";
export const EVIDENCE_DOMAIN = "rotk-attest-v1";
export const CHALLENGE_DOMAIN = "rotk-challenge-v1";
export const MANIFEST_SIGNATURE_DOMAIN = "rotk-manifest-sig-v1";

/**
 * Ed25519 public keys trusted to sign manifests and challenges, by keyId.
 * Rotation: add the new keyId here, ship the launcher, then start signing with
 * it. Revocation: remove the entry and ship again.
 *
 * Values are raw 32-byte Ed25519 public keys, base64url, no padding.
 */
export const TRUSTED_ATTESTATION_KEYS: Readonly<Record<string, string>> = Object.freeze({
  // Generated 2026-08-01 by scripts/generate-attestation-keypair.mjs.
  // Public keys are not secrets: this launcher is open source by design.
  // Rotation: add the new keyId, ship, switch the signing secret, then drop the
  // old entry in a later release to revoke it.
  "rotk-attest-2026-08": "1wcGNjmHAzinYVM0WbUzyGmIcv67nSTPfLTunS_Rv-4",
});

/**
 * Files excluded from the attestation root, lowercased, `/`-separated.
 *
 * MIRROR NOTICE: this list is duplicated in
 * `rotk-launcher/scripts/generate-base-manifest.mjs` and
 * `rotk-web/scripts/publish-attestation-policy.mjs` (standalone scripts that
 * cannot import this module). A divergence makes the launcher and the server
 * disagree on the expected root, rejecting every honest player. Both web tests
 * and launcher tests assert the lists match.
 *
 * General inclusion criteria — a path belongs here only if:
 *   1. it legitimately differs between two honest installations (per-player
 *      settings, keybinds), or is rewritten on every launch by the launcher; AND
 *   2. it cannot carry gameplay content or executable code.
 *
 * Explicit operator exception: the root-level `rotkc.dll` module may change
 * independently and is allowed with any content, or absent. This is a path
 * exemption, not a signature or hash verification of that module. It does not
 * cover nested copies, similarly named files, or other DLLs.
 *
 * Gameplay packs and other game-loaded executables remain attested. Existing
 * exceptions also cover vanilla `.original.dll` backups and Daybreak's unused,
 * independently updated LaunchPad bootstrap; ROTK starts H1Z1.exe directly.
 * `steam_api64.dll` and
 * `vivoxsdk_x64.dll` are NOT excluded — the launcher replaces them with its
 * own artifacts, so they are verified against those hashes instead (see
 * ATTESTATION_OVERRIDE_PATHS).
 *
 * Verified against a real installation (2026-08-01): the game rewrites
 * `UserOptions.ini` (graphics/audio/sensitivity) and `InputProfile_User.xml`
 * (keybinds) on every session, and both differ per player.
 */
export const ATTESTATION_EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  // Per-player, rewritten by the game itself.
  "useroptions.ini",
  "inputprofile_user.xml",
  // Daybreak updates this unused bootstrap independently. ROTK launches
  // H1Z1.exe directly; the game executable remains attested.
  "launchpad.exe",
  // Independently updated client module: exact root path, any hash, optional.
  "rotkc.dll",
  // Rewritten by the launcher before every launch.
  "clientconfig.ini",
  "battleye/beclient_x64.cfg",
  "steam_persona_name.txt",
  // Launcher bookkeeping and vanilla backups (absent from a pristine tree).
  ".rotk-installation.json",
  "clientconfig.original.ini",
  "battleye/beclient_x64.cfg.original",
  "steam_api64.original.dll",
  "vivoxsdk_x64.original.dll",
]);

/** Directory prefixes never part of the shipped tree (runtime output). */
export const ATTESTATION_EXCLUDED_PREFIXES: readonly string[] = [
  "logs/",
  "crashes/",
  "cache/",
  // BattlEye updates its own client binaries out of band; attesting them would
  // reject players mid-update. Deliberate gap — BattlEye guards itself.
  "battleye/",
  // CEF runtime owned by the unused Daybreak LaunchPad bootstrap. Keep the
  // in-game Browser/Resources tree attested.
  "launchpad.libs/",
];

/** Filename suffixes never part of the shipped tree. */
export const ATTESTATION_EXCLUDED_SUFFIXES: readonly string[] = [
  ".log",
  ".dmp",
  ".original",
];

/**
 * Files the launcher deliberately replaces: expected content is the launcher's
 * own artifact, not the vanilla one. They stay attested (they are executable
 * code — the highest-value target) but against the replacement hash, which the
 * release pipeline supplies from `resources/patches/*.sha256`.
 */
export const ATTESTATION_OVERRIDE_PATHS: readonly string[] = [
  "steam_api64.dll",
  "vivoxsdk_x64.dll",
  // Added by the launcher (no vanilla counterpart): attested via an override
  // entry, which mergeExpectedFiles accepts for new paths too.
  "vivoxsdk_x64_v5.dll",
  // Shotgun sprint DirectInput proxy (launcher 2.0.14+). Present only while
  // the server's client-patch mode is "patched"; the marker next to it is an
  // .ini and stays outside the attestation tree by design.
  "dinput8.dll",
];

/** True when a path must not take part in the attestation root. */
export function isAttestationExcluded(path: string): boolean {
  const lower = path.toLowerCase();
  if (ATTESTATION_EXCLUDED_PATHS.has(lower)) return true;
  if (ATTESTATION_EXCLUDED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return ATTESTATION_EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export type ManifestFileEntry = {
  /** Relative to the game installation root, `/`-separated, case preserved. */
  path: string;
  size: number;
  sha256: string;
};

export type DeviationKind = "missing" | "mismatch" | "unexpected";

export type ObservedDeviation = {
  path: string;
  kind: DeviationKind;
  observedSha256: string | null;
};

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Conservative path shape: no drive letters, no `..`, no backslashes. */
const MANIFEST_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:*?"<>|\r\n]+$/;

export class AttestationFormatError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AttestationFormatError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new AttestationFormatError(code, message);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function isManifestPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && MANIFEST_PATH.test(value);
}

/**
 * Canonical path key for ordering and duplicate detection.
 *
 * Windows paths are case-insensitive, so two entries differing only in case
 * would denote the same file. Ordering uses this key with a plain code-unit
 * comparison (NOT localeCompare, which is locale-dependent and would produce
 * different roots on different machines).
 */
export function manifestPathKey(path: string): string {
  return path.toLowerCase();
}

function compareEntries(left: ManifestFileEntry, right: ManifestFileEntry): number {
  const leftKey = manifestPathKey(left.path);
  const rightKey = manifestPathKey(right.path);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

/**
 * Canonical manifest root.
 *
 * root = SHA-256( "rotk-manifest-v1\0" || for each entry sorted by lowercased
 *                 path: path "\0" sha256 "\n" )
 *
 * The lowercased path is used only for ordering; the digest consumes the path
 * as declared, so a case change is a manifest change (and therefore a
 * deliberate release, not a silent drift).
 */
export function computeManifestRoot(entries: readonly ManifestFileEntry[]): string {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isManifestPath(entry.path)) fail("invalid-path", `Invalid manifest path: ${String(entry.path).slice(0, 80)}`);
    if (!isSha256Hex(entry.sha256)) fail("invalid-sha256", `Invalid sha256 for ${entry.path}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail("invalid-size", `Invalid size for ${entry.path}`);
    const key = manifestPathKey(entry.path);
    if (seen.has(key)) fail("duplicate-path", `Duplicate manifest path: ${entry.path}`);
    seen.add(key);
  }
  const hash = createHash("sha256");
  hash.update(`${MANIFEST_ROOT_DOMAIN}\0`, "utf8");
  for (const entry of [...entries].sort(compareEntries)) {
    hash.update(`${entry.path}\0${entry.sha256}\n`, "utf8");
  }
  return hash.digest("hex");
}

/**
 * Evidence bound to a server nonce.
 *
 * evidence = SHA-256( "rotk-attest-v1\0" || nonce(base64url, as received) ||
 *                     "\0" || root(hex) )
 *
 * The nonce is consumed as the exact ASCII the server sent, so both sides agree
 * without needing a shared base64 decoder convention.
 */
export function computeAttestationEvidence(nonce: string, root: string): string {
  if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128 || !BASE64URL.test(nonce)) {
    fail("invalid-nonce", "The attestation nonce is malformed.");
  }
  if (!isSha256Hex(root)) fail("invalid-root", "The manifest root is malformed.");
  return createHash("sha256")
    .update(`${EVIDENCE_DOMAIN}\0${nonce}\0${root}`, "utf8")
    .digest("hex");
}

/**
 * Bytes the server signs when issuing a challenge. The launcher verifies this
 * before hashing anything, so a spoofed backend cannot steer the computation.
 */
export function challengeSigningInput(challenge: {
  challengeId: string;
  nonce: string;
  policyVersion: string;
  expiresAt: string;
  /**
   * The fingerprint slots the server asks this launch for (#320 §B). Signed
   * with the rest, so a spoofed backend cannot choose what the machine
   * discloses. Absent on a challenge from a server that names none, and then
   * the bytes are exactly what they were before the pool existed.
   */
  hwidSlots?: readonly string[];
  /**
   * The client-patch mode the server directed for launcher 2.0.14+ (shotgun
   * sprint proxy installed or removed). Appended after the optional slot list
   * so launchers that predate the field verify exactly the bytes they always
   * did; absent on a challenge from a server that does not direct a mode.
   */
  clientPatchMode?: AttestationClientPatchMode;
}): string {
  return [
    CHALLENGE_DOMAIN,
    challenge.challengeId,
    challenge.nonce,
    challenge.policyVersion,
    challenge.expiresAt,
    ...(challenge.hwidSlots === undefined ? [] : [challenge.hwidSlots.join(",")]),
    ...(challenge.clientPatchMode === undefined ? [] : [challenge.clientPatchMode]),
  ].join("\0");
}

/**
 * Server-directed state of the launcher-installed shotgun sprint client patch.
 * Mirrored by the server's attestation policy and challenge signature.
 */
export type AttestationClientPatchMode = "patched" | "clean";

/** A fingerprint slot name as the server spells them: lowercase snake case. */
export const HWID_SLOT_NAME = /^[a-z0-9_]{1,40}$/;

/**
 * MIRROR NOTICE: duplicated byte for byte in the server's `tpmProof.ts`. What
 * the TPM key signs from launcher 2.0.12 on (#320 §C): the single-use
 * challengeId and the fingerprint vector exactly as the ticket body carries it
 * — raw strings, keys sorted, string values only — so a HWID cannot be swapped
 * under a genuine signature nor a genuine vector replayed under another
 * machine's key. Both sides derive it from the same JSON; no normalisation may
 * sit between them.
 */
export const TPM_BINDING_DOMAIN = "rotk-tpm-bind-v1";
export function tpmBindingMessage(challengeId: string, hwid: unknown): string {
  const entries: string[] = [];
  if (hwid !== null && typeof hwid === "object" && !Array.isArray(hwid)) {
    const vector = hwid as Record<string, unknown>;
    for (const key of Object.keys(vector).sort()) {
      const value = vector[key];
      if (typeof value === "string") entries.push(`${key}=${value}`);
    }
  }
  return [TPM_BINDING_DOMAIN, challengeId, ...entries].join("\0");
}

/**
 * Bytes the release tooling signs for a manifest or policy document. Only
 * identity-bearing fields participate: the document is reconstructed from them,
 * so no JSON canonicalization is needed.
 */
export function manifestSigningInput(document: {
  kind: string;
  schemaVersion: number;
  version: string;
  root: string;
  issuedAt: string;
  expiresAt?: string | null;
}): string {
  return [
    MANIFEST_SIGNATURE_DOMAIN,
    document.kind,
    String(document.schemaVersion),
    document.version,
    document.root,
    document.issuedAt,
    document.expiresAt ?? "",
  ].join("\0");
}

function ed25519PublicKeyDer(rawBase64Url: string): Buffer {
  const raw = Buffer.from(rawBase64Url, "base64url");
  if (raw.length !== 32) fail("invalid-public-key", "An Ed25519 public key must be 32 bytes.");
  // SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410).
  return Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
}

/**
 * Verifies an Ed25519 signature made by a trusted release key.
 *
 * Returns false — never throws — on any malformed input, unknown keyId or bad
 * signature, so callers fail closed with a single check.
 */
export function verifyAttestationSignature(
  signingInput: string,
  signatureBase64Url: unknown,
  keyId: unknown,
  trustedKeys: Readonly<Record<string, string>> = TRUSTED_ATTESTATION_KEYS,
): boolean {
  if (typeof keyId !== "string" || !Object.prototype.hasOwnProperty.call(trustedKeys, keyId)) return false;
  if (typeof signatureBase64Url !== "string" || !BASE64URL.test(signatureBase64Url)) return false;
  const signature = Buffer.from(signatureBase64Url, "base64url");
  if (signature.length !== 64) return false;
  try {
    return verifySignature(
      null,
      Buffer.from(signingInput, "utf8"),
      { key: ed25519PublicKeyDer(trustedKeys[keyId]), format: "der", type: "spki" },
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Frozen cross-implementation test vectors. Both the launcher (vitest) and the
 * backend (node:test) assert against these; a mismatch means the launcher and
 * server would disagree on what an unmodified installation hashes to.
 */
export const ATTESTATION_TEST_VECTORS = Object.freeze({
  manifestRoot: Object.freeze({
    entries: Object.freeze([
      // Deliberately unsorted, mixed case, to pin the ordering rule.
      { path: "Resources/Assets/assets_x64_1.pack2", size: 2, sha256: "b".repeat(64) },
      { path: "H1Z1.exe", size: 3, sha256: "c".repeat(64) },
      { path: "Resources/Assets/Assets_x64_0.pack2", size: 1, sha256: "a".repeat(64) },
    ]),
    expectedRoot: "09e1c2c3aa522584c69b4eaa768c7d09a7f8a3467fa1359eae8482875c849a1c",
  }),
  // tpmBindingMessage (#320 §C): raw strings, keys sorted, string values only,
  // NUL-joined behind the domain and the challengeId. Mirrored in the server's
  // attestationVerdict.ts.
  tpmBinding: Object.freeze({
    challengeId: "7c9e6679742540de944be07fc1f90ae7",
    hwid: Object.freeze({
      volume_serial: "1A2B3C4D",
      machine_guid: "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
      ignored: 5,
    }),
    expectedMessage: "rotk-tpm-bind-v1\0" + "7c9e6679742540de944be07fc1f90ae7\0"
      + "machine_guid=3F2504E0-4F89-41D3-9A0C-0305E82C3301\0" + "volume_serial=1A2B3C4D",
  }),
  evidence: Object.freeze({
    nonce: "dGVzdC1ub25jZS0xMjM0NTY3ODkw",
    root: "d".repeat(64),
    expectedEvidence: "fc8d2b2e1a15771ff1956aad1f2fa473afeb91d056c059c5c20bc370d918f8a2",
  }),
});
