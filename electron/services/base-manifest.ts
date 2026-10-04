/**
 * Fetches and verifies the signed BASE_MANIFEST — the authoritative list of
 * pristine game files for a supported client build.
 *
 * The manifest is public and cacheable; its authenticity comes from the Ed25519
 * signature of a pinned release key, so mirroring or caching it is harmless.
 * A manifest that fails verification is discarded, never used.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripByteOrderMark } from "./asset-sync.js";
import {
  isAttestationExcluded,
  isManifestPath,
  isSha256Hex,
  manifestSigningInput,
  verifyAttestationSignature,
  type ManifestFileEntry,
} from "../../shared/attestation.js";

/** Published beside the asset packs, in the same public repository. */
export const BASE_MANIFEST_URL =
  "https://raw.githubusercontent.com/ROTK-Team/assets/main/base-manifest.v1.json";

const CACHE_FILE_NAME = "base-manifest.v1.json";
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_FILES = 200_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Same allowlist as the asset feed: manifests ship beside the packs. */
const MANIFEST_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

export interface BaseManifest {
  schemaVersion: 1;
  kind: "base-game";
  buildId: string;
  root: string;
  fileCount: number;
  totalBytes: number;
  issuedAt: string;
  keyId: string;
  signature: string;
  files: ManifestFileEntry[];
}

function manifestError(reason: string): Error {
  return new Error(`Manifeste du jeu de base invalide : ${reason}.`);
}

export function parseBaseManifest(value: unknown): BaseManifest {
  if (!value || typeof value !== "object") throw manifestError("structure inattendue");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) throw manifestError("version non prise en charge");
  if (manifest.kind !== "base-game") throw manifestError("type inattendu");
  for (const field of ["buildId", "issuedAt", "keyId", "signature"] as const) {
    if (typeof manifest[field] !== "string" || (manifest[field] as string).length === 0) {
      throw manifestError(`champ ${field} manquant`);
    }
  }
  if (!isSha256Hex(manifest.root)) throw manifestError("racine invalide");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw manifestError("aucun fichier");
  if (manifest.files.length > MAX_MANIFEST_FILES) throw manifestError("trop de fichiers");

  const files: ManifestFileEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of manifest.files as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") throw manifestError("entrée inattendue");
    const { path, size, sha256 } = raw;
    if (!isManifestPath(path)) throw manifestError("chemin invalide");
    if (!isSha256Hex(sha256)) throw manifestError("empreinte invalide");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw manifestError("taille invalide");
    const key = (path as string).toLowerCase();
    if (seen.has(key)) throw manifestError("chemin en double");
    seen.add(key);
    totalBytes += size;
    files.push({ path: path as string, size, sha256: sha256 as string });
  }

  // Signature covers the identity fields and the root; the file list is bound
  // to it because the root is derived from the list (verified by the caller
  // recomputing it).
  const signed = verifyAttestationSignature(
    manifestSigningInput({
      kind: "base-game",
      schemaVersion: 1,
      version: manifest.buildId as string,
      root: manifest.root,
      issuedAt: manifest.issuedAt as string,
      expiresAt: null,
    }),
    manifest.signature,
    manifest.keyId,
  );
  if (!signed) throw manifestError("signature non reconnue");

  return {
    schemaVersion: 1,
    kind: "base-game",
    buildId: manifest.buildId as string,
    root: manifest.root,
    fileCount: files.length,
    totalBytes,
    issuedAt: manifest.issuedAt as string,
    keyId: manifest.keyId as string,
    signature: manifest.signature as string,
    files,
  };
}

function validateManifestUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw manifestError("URL invalide");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw manifestError("URL invalide");
  if (!MANIFEST_HOSTS.has(parsed.hostname)) throw manifestError(`hôte non autorisé (${parsed.hostname})`);
  return parsed.href;
}

export interface LoadBaseManifestOptions {
  url: string;
  userDataDirectory: string;
  expectedBuildId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Returns the verified manifest for `expectedBuildId`, preferring the network
 * and falling back to the cached copy (also re-verified) when offline.
 */
export async function loadBaseManifest(options: LoadBaseManifestOptions): Promise<BaseManifest> {
  const url = validateManifestUrl(options.url);
  const cachePath = join(options.userDataDirectory, CACHE_FILE_NAME);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw manifestError(`téléchargement refusé (${response.status})`);
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) throw manifestError("manifeste trop volumineux");
    const manifest = parseBaseManifest(JSON.parse(stripByteOrderMark(text)));
    if (manifest.buildId !== options.expectedBuildId) {
      throw manifestError(`build inattendu (${manifest.buildId})`);
    }
    await writeFile(cachePath, text, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    return manifest;
  } catch (networkError) {
    const cached = await readFile(cachePath, "utf8").catch(() => null);
    if (cached === null) throw networkError;
    const manifest = parseBaseManifest(JSON.parse(stripByteOrderMark(cached)));
    if (manifest.buildId !== options.expectedBuildId) throw networkError;
    return manifest;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Expected installation state = pristine base tree with launcher-installed
 * asset files layered on top (an asset legitimately replaces a base file).
 *
 * Per-player settings and launcher-rewritten files are dropped so a conforming
 * installation hashes to a stable root — see ATTESTATION_EXCLUDED_PATHS for the
 * inclusion criteria. `overrides` carries the launcher's own replacements
 * (shim DLLs), which stay attested against the replacement hash.
 */
export function mergeExpectedFiles(
  base: readonly ManifestFileEntry[],
  installedAssets: readonly ManifestFileEntry[],
  overrides: readonly ManifestFileEntry[] = [],
): ManifestFileEntry[] {
  const byKey = new Map<string, ManifestFileEntry>();
  for (const group of [base, installedAssets, overrides]) {
    for (const entry of group) {
      if (isAttestationExcluded(entry.path)) continue;
      byKey.set(entry.path.toLowerCase(), entry);
    }
  }
  return [...byKey.values()];
}

/** Re-exported for callers; the canonical rule lives in shared/attestation.ts. */
export { isAttestationExcluded } from "../../shared/attestation.js";

/**
 * Expected hashes for the files the launcher deliberately replaces or adds.
 *
 * Once per-player and launcher-rewritten files are excluded, a ROTK install
 * differs from a vanilla one by up to four files: `steam_api64.dll` (the
 * open-source shim), `vivoxsdk_x64.dll` (the ROTK voice proxy),
 * `vivoxsdk_x64_v5.dll` (the official Vivox 5 runtime, absent from a vanilla
 * tree — mergeExpectedFiles accepts overrides for new paths too) and, only
 * while the server directs the patched client-patch mode, `dinput8.dll` (the
 * shotgun sprint proxy). They stay attested — swapping one for a cheat DLL
 * must be caught — but against the launcher's own artifacts rather than the
 * vanilla hashes.
 *
 * Hashes come from the shipped `resources/patches/*.sha256`, which CI already
 * checks against a rebuild from source, so there is no third place to keep in
 * sync. A missing or unreadable sidecar yields no override: the file is then
 * compared to the vanilla hash and reported as a deviation, which is visible
 * and safe rather than silently trusted.
 */
export async function readLauncherOverrides(
  overrides: ReadonlyArray<{ installPath: string; bundledPath: string }>,
): Promise<ManifestFileEntry[]> {
  const entries: ManifestFileEntry[] = [];
  for (const { installPath, bundledPath } of overrides) {
    const digest = await readSidecarSha256(`${bundledPath}.sha256`);
    if (!digest) continue;
    const size = await stat(bundledPath).then((info) => info.size).catch(() => null);
    if (size === null) continue;
    entries.push({ path: installPath, size, sha256: digest });
  }
  return entries;
}

/** Parses a `<sha256> *<name>` sidecar, the format CI already produces. */
async function readSidecarSha256(path: string): Promise<string | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  const digest = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return isSha256Hex(digest) ? digest : null;
}

export const baseManifestInternals = { CACHE_FILE_NAME, validateManifestUrl };
