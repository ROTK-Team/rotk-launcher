/**
 * Launcher side of integrity attestation.
 *
 * Flow per launch:
 *   1. ask the backend for a signed, single-use challenge (phase A);
 *   2. verify the challenge signature against the pinned release keys — a
 *      spoofed backend must not be able to steer what we measure;
 *   3. measure the installation: hash every file the signed manifests declare,
 *      report anything missing / altered / unexpected;
 *   4. return the evidence, which the ticket request carries (phase B).
 *
 * Hashing several GB is slow, so `(path, size, mtimeMs) -> sha256` results are
 * cached in userData. Only the large archives (see isCachedArchive) take their
 * digest from the cache; every other declared file is small next to them and is
 * hashed again on every launch.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { retryFs } from "./fs-safe.js";
import { launcherUpdateRequiredError } from "./launch-ticket.js";
import {
  HWID_SLOT_NAME,
  computeAttestationEvidence,
  computeManifestRoot,
  challengeSigningInput,
  isAttestationExcluded,
  isManifestPath,
  isSha256Hex,
  manifestPathKey,
  TRUSTED_ATTESTATION_KEYS,
  verifyAttestationSignature,
  type AttestationClientPatchMode,
  type ManifestFileEntry,
  type ObservedDeviation,
} from "../../shared/attestation.js";

const CACHE_FILE_NAME = "integrity-hash-cache.v1.json";
const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_ENTRIES = 100_000;
const MAX_REPORTED_DEVIATIONS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
// The server issues 120 s challenges; a Date further out than this is not its clock.
const MAX_CHALLENGE_LIFETIME_MS = 3_600_000;

// Monotonic deadline of each challenge, measured against the server's Date.
const challengeDeadlines = new WeakMap<AttestationChallenge, number>();

export interface AttestationChallenge {
  challengeId: string;
  nonce: string;
  policyVersion: string;
  packVersion: string;
  baseBuildId: string;
  minLauncherVersion: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  /**
   * The fingerprint slots this launch is asked for (#320 §B), covered by the
   * signature. Absent from a server that names none: then the core five.
   */
  hwidSlots?: string[];
  /**
   * Server-directed shotgun sprint client-patch mode (launcher 2.0.14+),
   * covered by the signature. Absent on older servers; the caller then keeps
   * the client clean, which is what those servers' policies expect.
   */
  clientPatchMode?: AttestationClientPatchMode;
}

export interface AttestationProgress {
  phase: "challenge" | "measuring" | "done";
  hashedFiles: number;
  totalFiles: number;
  hashedBytes: number;
  totalBytes: number;
}

export interface AttestationClaim {
  policyVersion: string;
  packVersion: string;
  baseBuildId: string;
  launcherVersion: string;
  fileCount: number;
  totalBytes: number;
}

export interface AttestationResult {
  challengeId: string;
  evidence: string;
  claim: AttestationClaim;
  deviations: ObservedDeviation[];
  /**
   * Optional TPM proof over the challenge nonce (see tpm-identity.ts). Rides in
   * the attestation block because that is what already carries the challengeId
   * the server needs to bind it; absent when the machine has no usable TPM.
   */
  tpmProof?: { publicKey: string; signature: string; algo: string };
  /**
   * Optional level-2 anchor (see tpm-anchor.ts): the TPM identity key's proof
   * over the same message, with the TPM2B_PUBLIC that names it.
   */
  tpmAnchor?: { publicKey: string; signature: string; algo: string; tpmPublic: string };
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

type CacheMap = Map<string, CacheEntry>;

/**
 * A challenge could not be turned into a measurement. `notApplicable` marks the
 * case where the server has no attestation to run — no policy published, or the
 * feature unconfigured — which is a launch-as-usual, not a failure to surface.
 * Everything else (unreachable service, rejected key, malformed response) is a
 * genuine "could not verify", carried to the ticket flow so a blocked launch
 * can say why instead of blaming the launcher version.
 */
export class AttestationUnavailableError extends Error {
  readonly notApplicable: boolean;
  constructor(message: string, notApplicable = false) {
    super(message);
    this.name = "AttestationUnavailableError";
    this.notApplicable = notApplicable;
  }
}

function attestationError(message: string): Error {
  return new AttestationUnavailableError(message);
}

/** Rejects any endpoint that is not a bare HTTPS path, like launch-ticket.ts. */
function validateEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw attestationError("Invalid ROTK attestation endpoint");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    throw attestationError("Invalid ROTK attestation endpoint");
  }
  return parsed.href;
}

function parseChallenge(
  payload: unknown,
  trustedKeys: Readonly<Record<string, string>> = TRUSTED_ATTESTATION_KEYS,
): AttestationChallenge {
  if (!payload || typeof payload !== "object") throw attestationError("Invalid attestation challenge");
  const value = payload as Record<string, unknown>;
  const strings = [
    "challengeId", "nonce", "policyVersion", "packVersion",
    "baseBuildId", "minLauncherVersion", "expiresAt", "keyId", "signature",
  ] as const;
  for (const field of strings) {
    if (typeof value[field] !== "string" || value[field] === "") {
      throw attestationError("Invalid attestation challenge");
    }
  }
  // The slot list is optional but, when present, strict: a bounded list of
  // distinct slot names. It is part of the signed bytes below, so a list a
  // spoofed backend edits in transit fails the signature check.
  let hwidSlots: string[] | undefined;
  if (value.hwidSlots !== undefined) {
    const raw = value.hwidSlots;
    if (
      !Array.isArray(raw) || raw.length === 0 || raw.length > 40
      || !raw.every((slot) => typeof slot === "string" && HWID_SLOT_NAME.test(slot))
      || new Set(raw).size !== raw.length
    ) {
      throw attestationError("Invalid attestation challenge");
    }
    hwidSlots = [...(raw as string[])];
  }
  // The client-patch mode is optional and strict: two exact strings, signed
  // with the rest so a spoofed backend cannot silently toggle the local patch.
  let clientPatchMode: AttestationClientPatchMode | undefined;
  if (value.clientPatchMode !== undefined) {
    if (value.clientPatchMode !== "patched" && value.clientPatchMode !== "clean") {
      throw attestationError("Invalid attestation challenge");
    }
    clientPatchMode = value.clientPatchMode;
  }
  const challenge: AttestationChallenge = {
    challengeId: value.challengeId as string,
    nonce: value.nonce as string,
    policyVersion: value.policyVersion as string,
    packVersion: value.packVersion as string,
    baseBuildId: value.baseBuildId as string,
    minLauncherVersion: value.minLauncherVersion as string,
    expiresAt: value.expiresAt as string,
    keyId: value.keyId as string,
    signature: value.signature as string,
    ...(hwidSlots === undefined ? {} : { hwidSlots }),
    ...(clientPatchMode === undefined ? {} : { clientPatchMode }),
  };
  if (Number.isNaN(Date.parse(challenge.expiresAt))) {
    throw attestationError("Invalid attestation challenge");
  }
  // Signature check before any measurement: this is what makes the challenge
  // trustworthy enough to act on.
  const signed = verifyAttestationSignature(
    challengeSigningInput(challenge),
    challenge.signature,
    challenge.keyId,
    trustedKeys,
  );
  if (!signed) {
    throw attestationError(
      "The ROTK integrity challenge was not signed by a trusted key. Update the launcher and try again.",
    );
  }
  return challenge;
}

export async function requestAttestationChallenge(
  playerKey: string,
  endpointValue: string,
  launcherVersion: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Overridable for tests only; production always uses the pinned table. */
    trustedKeys?: Readonly<Record<string, string>>;
  } = {},
): Promise<AttestationChallenge> {
  const endpoint = validateEndpoint(endpointValue);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const requestedAtMonotonicMs = performance.now();
  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ launcherKey: playerKey, launcherVersion }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw attestationError("Unable to reach the ROTK integrity service");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw attestationError("Invalid response from the ROTK integrity service");
    }
    if (!response.ok) {
      // Two error shapes: the legacy flat `error: "code"` string, and the
      // self-hosted `error: { code, message }` object. Read both.
      const rawError = payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).error
        : null;
      const code = typeof rawError === "string"
        ? rawError
        : rawError && typeof rawError === "object"
          ? (rawError as Record<string, unknown>).code
          : null;
      if (code === "invalid_credentials") throw attestationError("The ROTK launcher key was rejected");
      if (code === "launcher_update_required") throw launcherUpdateRequiredError(payload);
      // No policy published, or attestation unconfigured on the server: the
      // self-hosted route answers failed-precondition, the legacy one
      // policy_unavailable. Neither is the player's problem — attestation
      // simply does not apply, so the launch proceeds and the ticket route
      // remains the single authority on whether it may.
      if (code === "policy_unavailable" || code === "failed-precondition") {
        throw new AttestationUnavailableError(
          "ROTK has no published integrity policy yet.",
          true,
        );
      }
      if (code === "rate_limited" || code === "resource-exhausted") {
        throw attestationError("Too many ROTK integrity checks. Wait a moment and try again");
      }
      throw attestationError("The ROTK integrity service is temporarily unavailable");
    }
    const challenge = parseChallenge(payload, options.trustedKeys ?? TRUSTED_ATTESTATION_KEYS);
    // expiresAt is on the server's clock and the PC's can be minutes off.
    // Like launch tickets, keep what the server says is left on the monotonic
    // clock from the request start; the second covers Date's truncation.
    const lifetimeMs = Date.parse(challenge.expiresAt) - Date.parse(response.headers.get("date") ?? "");
    if (Number.isFinite(lifetimeMs) && lifetimeMs <= MAX_CHALLENGE_LIFETIME_MS) {
      challengeDeadlines.set(challenge, requestedAtMonotonicMs + lifetimeMs - 1_000);
    }
    return challenge;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * How long the challenge stays valid for the server. Without a usable Date
 * on its response, the PC clock is all there is.
 */
export function attestationChallengeRemainingMs(
  challenge: AttestationChallenge,
  nowMonotonicMs = performance.now(),
): number {
  const deadline = challengeDeadlines.get(challenge);
  return deadline === undefined
    ? Date.parse(challenge.expiresAt) - Date.now()
    : deadline - nowMonotonicMs;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * The large archives: packs and sound banks, about 17.3 GB of an honest
 * install. Everything else declared (executables, fonts, UI and locale files,
 * single sounds) is about 350 MB, so it is always read from disk.
 */
const CACHED_ARCHIVE_EXTENSIONS = new Set(["pack2", "pack", "bnk_pc"]);

function isCachedArchive(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && CACHED_ARCHIVE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

async function loadCache(userDataDirectory: string): Promise<CacheMap> {
  try {
    const raw = JSON.parse(await readFile(join(userDataDirectory, CACHE_FILE_NAME), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return new Map();
    const record = raw as { schemaVersion?: unknown; entries?: unknown };
    if (record.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(record.entries)) return new Map();
    const cache: CacheMap = new Map();
    for (const entry of record.entries.slice(0, MAX_CACHE_ENTRIES)) {
      if (!entry || typeof entry !== "object") continue;
      const { path, size, mtimeMs, sha256 } = entry as Record<string, unknown>;
      if (typeof path !== "string" || typeof size !== "number" || typeof mtimeMs !== "number") continue;
      if (!isSha256Hex(sha256)) continue;
      cache.set(path, { size, mtimeMs, sha256 });
    }
    return cache;
  } catch {
    return new Map();
  }
}

async function saveCache(userDataDirectory: string, cache: CacheMap): Promise<void> {
  const entries = [...cache.entries()]
    .slice(0, MAX_CACHE_ENTRIES)
    .map(([path, entry]) => ({ path, ...entry }));
  try {
    await writeFile(
      join(userDataDirectory, CACHE_FILE_NAME),
      JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, entries }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // A cache we cannot persist only costs time on the next launch.
  }
}

export interface MeasureOptions {
  installationRoot: string;
  userDataDirectory: string;
  /** Expected files, from the signed base manifest merged with asset packs. */
  expected: readonly ManifestFileEntry[];
  /** Extra files found on disk that no manifest declares, if known. */
  unexpectedPaths?: readonly string[];
  /**
   * Walk the installation to find files no manifest declares. Off by default:
   * it costs a full directory traversal, and callers that already know the
   * extra paths should pass `unexpectedPaths` instead.
   */
  detectUnexpected?: boolean;
  onProgress?(progress: AttestationProgress): void;
}

/**
 * Extensions worth reporting when they appear undeclared inside the game tree.
 *
 * Deliberately narrow: an undeclared `.txt` next to the exe is noise, an
 * undeclared `.pack2` or `.dll` is someone shipping content or code into the
 * game. Excluded paths (per-player settings, logs, BattlEye) never reach here.
 */
const UNEXPECTED_EXTENSIONS = new Set([
  "pack2", "pack", "dll", "exe", "asset", "bundle", "dat", "bin",
]);

// Far above an honest install (about 700 entries); bounds a link to a huge folder.
const MAX_WALKED_ENTRIES = 100_000;

type EntryKind = "directory" | "file" | "other";

/** What a junction or symbolic link points to; a broken link is "other". */
async function linkTargetKind(path: string): Promise<EntryKind> {
  const target = await stat(path).catch(() => null);
  if (target?.isDirectory()) return "directory";
  return target?.isFile() ? "file" : "other";
}

/**
 * Walks the installation as the game opens it: a junction or symbolic link
 * counts as what it points to, and attestation exclusions apply to the path
 * inside the installation. Real folders are read before linked ones and each
 * physical folder only once, so a folder reachable both ways keeps its real
 * path and a link loop ends. Stops after `maxEntries` entries, or as soon as
 * `visit` returns false. `visit` gets each file's relative, `/`-separated path.
 */
export async function walkInstallation(
  installationRoot: string,
  visit: (relativePath: string) => boolean | void,
  maxEntries = MAX_WALKED_ENTRIES,
): Promise<void> {
  const visited = new Set<string>();
  const linkedFolders: string[] = [];
  let walkedEntries = 0;
  let stopped = false;
  const read = async (directory: string): Promise<void> => {
    const physical = await realpath(directory).catch(() => null);
    if (physical === null || visited.has(physical)) return;
    visited.add(physical);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (stopped) return;
      if (++walkedEntries > maxEntries) {
        stopped = true;
        return;
      }
      const absolute = join(directory, entry.name);
      const relative = installationRelativePath(installationRoot, absolute);
      const kind: EntryKind = entry.isSymbolicLink()
        ? await linkTargetKind(absolute)
        : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      // File exemptions must not hide a directory with the same name. The
      // trailing slash still lets directory-prefix exclusions skip their tree.
      if (isAttestationExcluded(kind === "directory" ? `${relative}/` : relative)) continue;
      if (kind === "directory") {
        if (entry.isSymbolicLink()) linkedFolders.push(absolute);
        else await read(absolute);
        continue;
      }
      if (kind === "file" && visit(relative) === false) {
        stopped = true;
        return;
      }
    }
  };
  await read(installationRoot);
  // Linked folders last: one also reachable directly was read under its real
  // path above and is skipped here.
  while (!stopped && linkedFolders.length > 0) await read(linkedFolders.shift()!);
}

/** Enumerates undeclared files of interest under the installation root. */
async function findUnexpectedFiles(
  installationRoot: string,
  declared: ReadonlySet<string>,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relative = installationRelativePath(installationRoot, absolute);
      // File exemptions must not hide a directory with the same name. The
      // trailing slash still lets directory-prefix exclusions skip their tree.
      if (isAttestationExcluded(entry.isDirectory() ? `${relative}/` : relative)) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      // Symlinks and specials are skipped: following them could reach outside
      // the installation, and a pristine tree contains none.
      if (!entry.isFile()) continue;
      if (declared.has(manifestPathKey(relative))) continue;
      const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
      if (!UNEXPECTED_EXTENSIONS.has(extension)) continue;
      found.push(relative);
      if (found.length >= MAX_REPORTED_DEVIATIONS) return;
    }
  };
  await walk(installationRoot);
  return found;
}

/** Executable code: what the game, or a module loader, can run from the tree. */
const CODE_EXTENSIONS = new Set(["dll", "exe", "asi"]);

function isCodePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Executable files in the attested tree, through links too, as walkInstallation
 * sees them. A folder link whose name ends in .dll is a folder, not a module.
 */
async function listCodeFiles(installationRoot: string): Promise<string[]> {
  const found: string[] = [];
  await walkInstallation(installationRoot, (relativePath) => {
    if (isCodePath(relativePath)) found.push(relativePath);
  });
  return found;
}

/** An executable file as the measurement saw it. */
export interface MeasuredCodeFile {
  /** Relative to the installation root, `/`-separated, as found on disk. */
  path: string;
  size: number;
  /** Null when the file could not be read during the measurement. */
  sha256: string | null;
}

/**
 * Right before H1Z1 starts: the first executable file that was changed,
 * removed or added since the measurement, or null when the code on disk is
 * still the code that was measured. Every file is read again; the cache is
 * never used here.
 */
export async function findCodeChangedSinceMeasurement(
  installationRoot: string,
  measured: readonly MeasuredCodeFile[],
): Promise<string | null> {
  const known = new Set(measured.map((file) => manifestPathKey(file.path)));
  for (const path of await listCodeFiles(installationRoot)) {
    if (!known.has(manifestPathKey(path))) return path;
  }
  for (const file of measured) {
    const absolute = join(installationRoot, ...file.path.split("/"));
    const fileStat = await stat(absolute).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size !== file.size) return file.path;
    // An antivirus scan can hold a file for a moment; a real change stays.
    const digest = await retryFs(() => sha256File(absolute)).catch(() => null);
    if (digest !== file.sha256) return file.path;
  }
  return null;
}

export interface Measurement {
  root: string;
  fileCount: number;
  totalBytes: number;
  deviations: ObservedDeviation[];
  /**
   * Every executable file in the measured tree, declared or not, with the
   * digest it was measured with. Local only: not part of the evidence.
   */
  code: MeasuredCodeFile[];
}

/**
 * Hashes the declared installation and derives its canonical root.
 *
 * A file that is missing or altered is reported as a deviation AND folded into
 * the root as observed, so the server sees both the self-report and a digest
 * that cannot match the expected one.
 */
export async function measureInstallation(options: MeasureOptions): Promise<Measurement> {
  const { installationRoot, userDataDirectory, expected, onProgress } = options;
  const cache = await loadCache(userDataDirectory);
  const nextCache: CacheMap = new Map();
  const deviations: ObservedDeviation[] = [];
  const observed: ManifestFileEntry[] = [];
  const totalBytes = expected.reduce((sum, entry) => sum + entry.size, 0);
  let hashedFiles = 0;
  let hashedBytes = 0;

  onProgress?.({ phase: "measuring", hashedFiles: 0, totalFiles: expected.length, hashedBytes: 0, totalBytes });

  for (const entry of expected) {
    if (!isManifestPath(entry.path)) throw attestationError("The integrity manifest contains an invalid path.");
    const absolute = join(installationRoot, ...entry.path.split("/"));
    const fileStat = await stat(absolute).catch(() => null);
    if (!fileStat?.isFile()) {
      deviations.push({ path: entry.path, kind: "missing", observedSha256: null });
      hashedFiles += 1;
      continue;
    }
    const cacheKey = manifestPathKey(entry.path);
    // Only an archive may take its digest from the cache; see isCachedArchive.
    const cached = isCachedArchive(entry.path) ? cache.get(cacheKey) : undefined;
    const digest = cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs
      ? cached.sha256
      : await sha256File(absolute);
    nextCache.set(cacheKey, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, sha256: digest });
    observed.push({ path: entry.path, size: fileStat.size, sha256: digest });
    if (digest !== entry.sha256) {
      deviations.push({ path: entry.path, kind: "mismatch", observedSha256: digest });
    }
    hashedFiles += 1;
    hashedBytes += fileStat.size;
    if (hashedFiles % 50 === 0) {
      onProgress?.({ phase: "measuring", hashedFiles, totalFiles: expected.length, hashedBytes, totalBytes });
    }
  }

  const unexpected = options.detectUnexpected
    ? await findUnexpectedFiles(installationRoot, new Set(expected.map((entry) => manifestPathKey(entry.path))))
    : (options.unexpectedPaths ?? []);
  for (const path of unexpected) {
    if (!isManifestPath(path) || isAttestationExcluded(path)) continue;
    const absolute = join(installationRoot, ...path.split("/"));
    const digest = await sha256File(absolute).catch(() => null);
    deviations.push({ path, kind: "unexpected", observedSha256: digest });
    if (digest) {
      const fileStat = await stat(absolute).catch(() => null);
      observed.push({ path, size: fileStat?.size ?? 0, sha256: digest });
    }
  }

  // What the launch checks again right before H1Z1 starts. Declared files
  // keep the digest that went into the root; anything else is read now.
  const measuredDigests = new Map(observed.map((entry) => [manifestPathKey(entry.path), entry.sha256]));
  const code: MeasuredCodeFile[] = [];
  for (const path of await listCodeFiles(installationRoot)) {
    const absolute = join(installationRoot, ...path.split("/"));
    const fileStat = await stat(absolute).catch(() => null);
    code.push({
      path,
      size: fileStat?.size ?? -1,
      sha256: measuredDigests.get(manifestPathKey(path)) ?? await sha256File(absolute).catch(() => null),
    });
  }

  await saveCache(userDataDirectory, nextCache);
  onProgress?.({ phase: "done", hashedFiles, totalFiles: expected.length, hashedBytes, totalBytes });

  return {
    root: computeManifestRoot(observed),
    fileCount: observed.length,
    totalBytes: observed.reduce((sum, entry) => sum + entry.size, 0),
    deviations: deviations.slice(0, MAX_REPORTED_DEVIATIONS),
    code,
  };
}

/** Binds a measurement to a challenge, producing the block the ticket carries. */
export function buildAttestationResult(
  challenge: AttestationChallenge,
  measurement: Measurement,
  launcherVersion: string,
  tpmProof?: { publicKey: string; signature: string; algo: string } | null,
  tpmAnchor?: { publicKey: string; signature: string; algo: string; tpmPublic: string } | null,
): AttestationResult {
  return {
    challengeId: challenge.challengeId,
    evidence: computeAttestationEvidence(challenge.nonce, measurement.root),
    claim: {
      policyVersion: challenge.policyVersion,
      packVersion: challenge.packVersion,
      baseBuildId: challenge.baseBuildId,
      launcherVersion,
      fileCount: measurement.fileCount,
      totalBytes: measurement.totalBytes,
    },
    deviations: measurement.deviations,
    ...(tpmProof ? { tpmProof } : {}),
    ...(tpmAnchor ? { tpmAnchor } : {}),
  };
}

/** Relative, `/`-separated path of an absolute file inside the installation. */
export function installationRelativePath(installationRoot: string, absolutePath: string): string {
  return relative(installationRoot, absolutePath).split(sep).join("/");
}

export const integrityAttestationInternals = {
  parseChallenge,
  validateEndpoint,
  loadCache,
  saveCache,
  isCachedArchive,
  CACHE_FILE_NAME,
};
