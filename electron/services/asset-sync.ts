import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssetSyncProgress } from "../../shared/contracts.js";
import {
  CRITICAL_CLIENT_FILES,
  FORBIDDEN_INSTALL_SEGMENTS,
  INSTALL_MARKER_NAME,
} from "../constants.js";
import { assertSafeGeneratedStagingPath } from "./path-policy.js";
import { extractZipEntry, readZipDirectory } from "./zip-archive.js";

/**
 * Downloads the custom ROTK asset packs published on the dedicated GitHub
 * repository and installs them into the ROTK client folder. The feed never
 * replaces the bundled launcher patches (steam shim, vivox) and can never
 * deliver executable code: binaries stay in the signed launcher.
 */

export const ASSET_FEED_URL = "https://raw.githubusercontent.com/h1z1rotk/assets/main/feed.json";
export const ASSET_RELEASE_API_URL = "https://api.github.com/repos/h1z1rotk/assets/releases/latest";

/** Hosts an asset URL may declare in the manifest. */
const ASSET_URL_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);
/** Additional hosts GitHub is allowed to redirect release downloads to. */
const ASSET_REDIRECT_HOSTS = new Set([
  ...ASSET_URL_HOSTS,
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const RELEASE_API_HOSTS = new Set(["api.github.com"]);

const MAX_FEED_BYTES = 1_000_000;
const MAX_RELEASE_METADATA_BYTES = 1_000_000;
const MAX_ASSETS = 64;
/**
 * Also bounds a single extracted zip entry: the main game pack
 * (assets_x64_0.pack2) is 2.47 GB uncompressed. Entries must stay below
 * 4 GiB regardless — the zip reader rejects Zip64 archives.
 */
const MAX_ASSET_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_REDIRECTS = 5;
const MANIFEST_TIMEOUT_MS = 10_000;
const STATE_FILE_NAME = "asset-state.v1.json";
const CACHE_DIRECTORY_NAME = "asset-cache";
const BACKUP_DIRECTORY_NAME = "asset-backups";

/**
 * The feed distributes data files only. Anything Windows may execute or load
 * as a module keeps being shipped inside the signed launcher instead.
 */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "sys", "bat", "cmd", "ps1", "msi", "scr", "com", "vbs", "lnk",
]);
const RESERVED_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Root files the feed must never touch, lowercase, `/`-separated. */
const RESERVED_TARGETS = new Set([
  ...CRITICAL_CLIENT_FILES.map((name) => name.toLocaleLowerCase("en-US")),
  "dinput8.dll",
  INSTALL_MARKER_NAME.toLocaleLowerCase("en-US"),
]);
/** The BattlEye folder is patched by the installer and stays feed-immutable. */
const FORBIDDEN_ASSET_SEGMENTS = new Set([...FORBIDDEN_INSTALL_SEGMENTS, "battleye"]);

export interface AssetManifestEntry {
  name: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
  installPath: string;
  type: "zip" | "file";
  /** Exact root entry required for a pack auto-discovered from GitHub Releases. */
  releasePackEntry?: string;
}

export interface AssetManifest {
  manifestVersion: 1;
  packVersion: string;
  assets: AssetManifestEntry[];
}

interface InstalledFileRecord {
  /** Relative to the ROTK installation root, `/`-separated. */
  path: string;
  sha256: string;
  size: number;
}

interface InstalledAssetRecord {
  name: string;
  version: string;
  sha256: string;
  installedFiles: InstalledFileRecord[];
}

export interface AssetSyncState {
  schemaVersion: 1;
  packVersion: string;
  syncedAt: string;
  assets: InstalledAssetRecord[];
}

export interface AssetSyncOutcome {
  status: "up-to-date" | "updated" | "offline-warning";
  packVersion: string | null;
}

export interface AssetSyncServiceOptions {
  userDataDirectory: string;
  feedUrl?: string;
  releaseApiUrl?: string;
  discoverReleaseAssets?: boolean;
  fetchImpl?: typeof fetch;
  onProgress?(progress: AssetSyncProgress): void;
}

interface GitHubReleaseAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

function manifestError(reason: string): Error {
  return new Error(`Manifeste d’assets invalide : ${reason}.`);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * JSON.parse rejects a leading BOM, and Windows tooling emits one by default.
 * A feed published with a BOM would otherwise stop every launcher.
 */
export function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function hasBlockedExtension(fileName: string): boolean {
  const extension = fileName.split(".").at(-1) ?? "";
  return extension !== fileName && BLOCKED_EXTENSIONS.has(extension.toLocaleLowerCase("en-US"));
}

function validateInstallSegment(segment: string, context: string): void {
  if (segment.length === 0 || segment === "." || segment === "..") {
    throw manifestError(`chemin non autorisé (${context})`);
  }
  if (segment.endsWith(".") || segment.endsWith(" ") || segment.startsWith(" ")) {
    throw manifestError(`chemin non autorisé (${context})`);
  }
  for (const char of segment) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || "\\:*?\"<>|".includes(char)) {
      throw manifestError(`chemin non autorisé (${context})`);
    }
  }
  if (RESERVED_DEVICE_NAMES.test(segment.split(".")[0])) {
    throw manifestError(`chemin non autorisé (${context})`);
  }
  if (FORBIDDEN_ASSET_SEGMENTS.has(segment.toLocaleLowerCase("en-US"))) {
    throw manifestError(`chemin non autorisé (${context})`);
  }
  if (segment.toLocaleLowerCase("en-US").includes(".original.")) {
    throw manifestError(`chemin non autorisé (${context})`);
  }
}

/**
 * Validate a manifest `installPath` or a zip entry path joined to its pack
 * root. Returns the normalized `/`-separated relative path. `kind` decides
 * whether the value addresses a file (extension and reserved-file rules
 * apply) or an extraction directory (`"."` allowed).
 */
function validateInstallRelativePath(value: string, kind: "file" | "directory"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 400) {
    throw manifestError(`chemin non autorisé (${String(value).slice(0, 80)})`);
  }
  if (kind === "directory" && value === ".") return "";
  const context = value.slice(0, 120);
  if (value.includes("\\")) throw manifestError(`chemin non autorisé (${context})`);
  if (value.startsWith("/") || value.endsWith("/")) throw manifestError(`chemin non autorisé (${context})`);
  const segments = value.split("/");
  for (const segment of segments) validateInstallSegment(segment, context);
  const normalized = segments.join("/");
  if (kind === "file") {
    if (RESERVED_TARGETS.has(normalized.toLocaleLowerCase("en-US"))) {
      throw manifestError(`fichier protégé (${context})`);
    }
    if (hasBlockedExtension(segments.at(-1)!)) {
      throw manifestError(`extension interdite (${context})`);
    }
  }
  return normalized;
}

function joinRelativePaths(base: string, name: string): string {
  return base.length === 0 ? name : `${base}/${name}`;
}

export function parseAssetManifest(value: unknown): AssetManifest {
  if (!value || typeof value !== "object") throw manifestError("structure inattendue");
  const manifest = value as Partial<AssetManifest>;
  if (manifest.manifestVersion !== 1) throw manifestError("version de manifeste non prise en charge");
  if (
    typeof manifest.packVersion !== "string"
    || manifest.packVersion.length === 0
    || manifest.packVersion.length > 64
  ) {
    throw manifestError("packVersion manquant");
  }
  if (!Array.isArray(manifest.assets)) throw manifestError("liste d’assets manquante");
  if (manifest.assets.length > MAX_ASSETS) throw manifestError("trop d’assets");

  const names = new Set<string>();
  const fileTargets = new Set<string>();
  let totalBytes = 0;
  const assets: AssetManifestEntry[] = [];
  for (const item of manifest.assets as Array<Partial<AssetManifestEntry>>) {
    if (!item || typeof item !== "object") throw manifestError("entrée d’asset inattendue");
    const { name, version, url, sha256, size, installPath, type } = item;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      throw manifestError("nom d’asset invalide");
    }
    if (names.has(name)) throw manifestError(`asset en double (${name})`);
    names.add(name);
    if (typeof version !== "string" || version.length === 0 || version.length > 64) {
      throw manifestError(`version invalide (${name})`);
    }
    if (!isHex64(sha256)) throw manifestError(`sha256 invalide (${name})`);
    if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > MAX_ASSET_BYTES) {
      throw manifestError(`taille invalide (${name})`);
    }
    totalBytes += size as number;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw manifestError("taille totale des assets trop grande");
    if (type !== "zip" && type !== "file") throw manifestError(`type invalide (${name})`);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(String(url));
    } catch {
      throw manifestError(`URL invalide (${name})`);
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
      throw manifestError(`URL invalide (${name})`);
    }
    if (!ASSET_URL_HOSTS.has(parsedUrl.hostname)) {
      throw manifestError(`hôte non autorisé (${parsedUrl.hostname})`);
    }

    if (typeof installPath !== "string") throw manifestError(`chemin non autorisé (${name})`);
    const normalizedPath = validateInstallRelativePath(
      installPath,
      type === "zip" ? "directory" : "file",
    );
    if (type === "file") {
      const lowerTarget = normalizedPath.toLocaleLowerCase("en-US");
      if (fileTargets.has(lowerTarget)) throw manifestError(`cible en double (${normalizedPath})`);
      fileTargets.add(lowerTarget);
    }
    assets.push({
      name,
      version,
      url: parsedUrl.href,
      sha256,
      size: size as number,
      installPath: type === "zip" ? (normalizedPath === "" ? "." : normalizedPath) : normalizedPath,
      type,
    });
  }
  return { manifestVersion: 1, packVersion: manifest.packVersion, assets };
}

/**
 * Make the published GitHub release authoritative for conventional one-pack
 * ZIP payloads. A newly uploaded foo.zip is interpreted strictly as a ZIP
 * containing exactly foo.pack2 at its root and installed in Resources/Assets.
 * GitHub's size and SHA-256 digest become the download contract.
 */
export function mergeGitHubReleaseAssets(
  manifest: AssetManifest,
  value: unknown,
): AssetManifest {
  if (!value || typeof value !== "object") throw manifestError("release GitHub inattendue");
  const release = value as GitHubRelease;
  if (release.draft === true || release.prerelease === true) {
    throw manifestError("release GitHub non stable");
  }
  if (
    typeof release.tag_name !== "string"
    || !/^assets-v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag_name)
  ) {
    throw manifestError("tag de release GitHub invalide");
  }
  if (!Array.isArray(release.assets)) {
    throw manifestError("liste de release GitHub manquante");
  }
  if (release.assets.length > MAX_ASSETS) {
    throw manifestError("trop d'assets dans la release GitHub");
  }

  const releaseVersion = release.tag_name.slice("assets-v".length);
  const byName = new Map(
    manifest.assets.map((asset) => [
      asset.name.toLocaleLowerCase("en-US"),
      asset,
    ] as const),
  );
  const releasePackEntries = new Map<string, string>();

  for (const raw of release.assets as GitHubReleaseAsset[]) {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string") continue;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}\.zip$/i.test(raw.name)) continue;

    const stem = raw.name.slice(0, -".zip".length);
    const name = stem.toLocaleLowerCase("en-US");
    const digest = typeof raw.digest === "string" && raw.digest.startsWith("sha256:")
      ? raw.digest.slice("sha256:".length).toLocaleLowerCase("en-US")
      : "";
    if (!isHex64(digest)) {
      throw manifestError("empreinte GitHub absente (" + raw.name + ")");
    }
    if (!Number.isSafeInteger(raw.size) || (raw.size as number) <= 0) {
      throw manifestError("taille GitHub invalide (" + raw.name + ")");
    }

    const expectedUrl = "https://github.com/h1z1rotk/assets/releases/download/"
      + release.tag_name + "/" + raw.name;
    if (raw.browser_download_url !== expectedUrl) {
      throw manifestError("URL GitHub inattendue (" + raw.name + ")");
    }

    byName.set(name, {
      name,
      version: releaseVersion,
      url: expectedUrl,
      sha256: digest,
      size: raw.size as number,
      installPath: "Resources/Assets",
      type: "zip",
    });
    releasePackEntries.set(name, stem + ".pack2");
  }

  const merged = parseAssetManifest({
    manifestVersion: 1,
    packVersion: releaseVersion,
    assets: [...byName.values()],
  });
  return {
    ...merged,
    assets: merged.assets.map((asset) => {
      const releasePackEntry = releasePackEntries.get(
        asset.name.toLocaleLowerCase("en-US"),
      );
      return releasePackEntry ? { ...asset, releasePackEntry } : asset;
    }),
  };
}

function isInstalledFileRecord(value: unknown): value is InstalledFileRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<InstalledFileRecord>;
  return typeof record.path === "string"
    && record.path.length > 0
    && isHex64(record.sha256)
    && Number.isSafeInteger(record.size);
}

function isAssetSyncState(value: unknown): value is AssetSyncState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AssetSyncState>;
  return state.schemaVersion === 1
    && typeof state.packVersion === "string"
    && typeof state.syncedAt === "string"
    && Array.isArray(state.assets)
    && state.assets.every((asset) =>
      asset
      && typeof asset === "object"
      && typeof (asset as InstalledAssetRecord).name === "string"
      && typeof (asset as InstalledAssetRecord).version === "string"
      && isHex64((asset as InstalledAssetRecord).sha256)
      && Array.isArray((asset as InstalledAssetRecord).installedFiles)
      && (asset as InstalledAssetRecord).installedFiles.every(isInstalledFileRecord));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Move a file: an instant rename on the same drive, otherwise copied, checked
 * with `verify`, and only then deleted. Returns false when it stayed in place.
 */
async function moveFile(from: string, to: string, verify: (copy: string) => Promise<boolean>): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") return false;
  }
  const temporary = `${to}.${randomUUID()}.tmp`;
  try {
    await copyFile(from, temporary);
    if (!(await verify(temporary))) return false;
    await rename(temporary, to);
    await rm(from, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function relativeToNative(relativePath: string): string {
  return relativePath.split("/").join(sep);
}

/**
 * Each pending pack is downloaded, then extracted next to its target, with the
 * replaced original backed up: plan for about three times the download size.
 */
async function ensureFreeSpace(directory: string, downloadBytes: number): Promise<void> {
  if (downloadBytes === 0) return;
  const disk = await statfs(directory).catch(() => null);
  if (!disk) return;
  const requiredBytes = downloadBytes * 3;
  if (Number(disk.bavail) * Number(disk.bsize) < requiredBytes) {
    throw new Error(`Espace disque insuffisant pour les assets : ${Math.ceil(requiredBytes / 1024 ** 3)} Go sont nécessaires.`);
  }
}

export class AssetSyncService {
  private readonly statePath: string;
  // Up to 2.0.23 cache and backups lived in userData, on C:, whatever drive the
  // game was on. Old backups are still honoured; current packs are moved out
  // of the old cache.
  private readonly legacyCacheDirectory: string;
  private readonly legacyBackupDirectory: string;
  private cacheDirectory: string;
  private backupDirectory: string;
  private readonly feedUrl: string;
  private readonly releaseApiUrl: string;
  private readonly discoverReleaseAssets: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly onProgress: (progress: AssetSyncProgress) => void;
  private lastProgressAt = 0;

  constructor(options: AssetSyncServiceOptions) {
    this.statePath = join(options.userDataDirectory, STATE_FILE_NAME);
    this.legacyCacheDirectory = join(options.userDataDirectory, CACHE_DIRECTORY_NAME);
    this.legacyBackupDirectory = join(options.userDataDirectory, BACKUP_DIRECTORY_NAME);
    this.cacheDirectory = this.legacyCacheDirectory;
    this.backupDirectory = this.legacyBackupDirectory;
    this.feedUrl = options.feedUrl ?? ASSET_FEED_URL;
    this.releaseApiUrl = options.releaseApiUrl ?? ASSET_RELEASE_API_URL;
    this.discoverReleaseAssets = options.discoverReleaseAssets ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onProgress = options.onProgress ?? (() => undefined);
  }

  /**
   * Keep the cache and backups on the game's drive, next to the install
   * (`D:\Games\.ROTK-assets`), outside the attested tree.
   */
  private useStorageFor(root: string): void {
    const base = join(dirname(root), `.${basename(root)}-assets`);
    this.cacheDirectory = join(base, CACHE_DIRECTORY_NAME);
    this.backupDirectory = join(base, BACKUP_DIRECTORY_NAME);
  }

  async readState(): Promise<AssetSyncState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      return isAssetSyncState(parsed) ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /**
   * Bring the installed assets in line with the published feed. A feed that
   * cannot be fetched is only fatal when no sync ever completed: afterwards
   * the game keeps launching with the assets already on disk.
   */
  async sync(
    installRoot: string,
    options: { thorough?: boolean; signal?: AbortSignal } = {},
  ): Promise<AssetSyncOutcome> {
    const root = resolve(installRoot);
    if (!(await exists(join(root, INSTALL_MARKER_NAME)))) {
      throw new Error("Installe d’abord le client ROTK.");
    }
    this.useStorageFor(root);
    const state = await this.readState();

    let manifest: AssetManifest;
    try {
      manifest = await this.fetchManifest(options.signal);
    } catch (error) {
      if (state) return { status: "offline-warning", packVersion: state.packVersion };
      throw error instanceof Error && error.message.startsWith("Manifeste")
        ? error
        : new Error("Le flux d’assets ROTK est indisponible. Vérifie ta connexion puis réessaie.");
    }

    await this.adoptLegacyCache(manifest);
    await this.adoptLegacyBackups();
    const previousRecords = new Map((state?.assets ?? []).map((asset) => [asset.name, asset]));
    const ownedFiles = new Set(
      (state?.assets ?? []).flatMap((asset) =>
        asset.installedFiles.map((file) => file.path.toLocaleLowerCase("en-US"))),
    );

    const pending: AssetManifestEntry[] = [];
    const keptRecords: InstalledAssetRecord[] = [];
    for (const asset of manifest.assets) {
      const record = previousRecords.get(asset.name);
      if (!record || record.version !== asset.version || record.sha256 !== asset.sha256) {
        pending.push(asset);
        continue;
      }
      // Standalone files are cheap enough to hash on every launch and may be
      // replaced by a same-size vanilla variant. ZIP-backed packs keep the
      // fast size check unless the player explicitly runs Verify files.
      const thorough = options.thorough === true || asset.type === "file";
      if (await this.recordNeedsRepair(root, record, thorough)) pending.push(asset);
      else keptRecords.push(record);
    }

    const totalBytes = pending.reduce((sum, asset) => sum + asset.size, 0);
    await ensureFreeSpace(dirname(root), totalBytes);
    let completedBytes = 0;
    let assetsCompleted = 0;
    const emit = (phase: AssetSyncProgress["phase"], assetName: string, force = false): void => {
      const now = Date.now();
      if (!force && now - this.lastProgressAt < 80) return;
      this.lastProgressAt = now;
      this.onProgress({
        phase,
        assetName,
        assetsCompleted,
        totalAssets: pending.length,
        completedBytes,
        totalBytes,
      });
    };

    const newRecords: InstalledAssetRecord[] = [...keptRecords];
    for (const asset of pending) {
      emit("downloading", asset.name, true);
      const cachePath = await this.ensureCachedAsset(asset, options.signal, (amount) => {
        completedBytes += amount;
        emit("downloading", asset.name);
      });
      emit("installing", asset.name, true);
      newRecords.push(await this.installAsset(root, asset, cachePath, ownedFiles));
      assetsCompleted += 1;
      emit("installing", asset.name, true);
    }

    // Files owned by a previous sync that no manifest asset provides anymore
    // are restored from backup (or removed when the launcher created them).
    const desiredFiles = new Set(
      newRecords.flatMap((record) =>
        record.installedFiles.map((file) => file.path.toLocaleLowerCase("en-US"))),
    );
    for (const record of state?.assets ?? []) {
      for (const file of record.installedFiles) {
        if (!desiredFiles.has(file.path.toLocaleLowerCase("en-US"))) {
          await this.restoreOrRemove(root, file.path);
        }
      }
    }

    const changed = pending.length > 0 || (state?.packVersion ?? null) !== manifest.packVersion
      || (state?.assets.length ?? 0) !== newRecords.length;
    await this.writeState({
      schemaVersion: 1,
      packVersion: manifest.packVersion,
      syncedAt: new Date().toISOString(),
      assets: newRecords,
    });
    await this.pruneCache(manifest);
    return { status: changed ? "updated" : "up-to-date", packVersion: manifest.packVersion };
  }

  /** Repair pass: re-hash every installed file and reinstall what drifted. */
  async verify(installRoot: string, signal?: AbortSignal): Promise<AssetSyncOutcome> {
    return this.sync(installRoot, { thorough: true, signal });
  }

  /**
   * Return the client to its pre-asset state: restore every backed-up
   * original, delete the files the feed added, then forget the sync state.
   */
  async restore(installRoot: string): Promise<void> {
    const root = resolve(installRoot);
    this.useStorageFor(root);
    const state = await this.readState();
    for (const record of state?.assets ?? []) {
      for (const file of record.installedFiles) {
        await this.restoreOrRemove(root, file.path);
      }
    }
    await rm(this.statePath, { force: true });
    await rm(this.backupDirectory, { recursive: true, force: true });
    await rm(this.legacyBackupDirectory, { recursive: true, force: true });
  }

  private async recordNeedsRepair(
    root: string,
    record: InstalledAssetRecord,
    thorough: boolean,
  ): Promise<boolean> {
    for (const file of record.installedFiles) {
      const target = this.resolveTarget(root, file.path);
      const details = await stat(target).catch(() => null);
      if (!details?.isFile() || details.size !== file.size) return true;
      if (thorough && (await sha256File(target)) !== file.sha256) return true;
    }
    return false;
  }

  private resolveTarget(root: string, relativePath: string): string {
    const target = resolve(join(root, relativeToNative(relativePath)));
    if (!target.toLocaleLowerCase("en-US").startsWith(`${root.toLocaleLowerCase("en-US")}${sep}`)) {
      throw manifestError(`chemin non autorisé (${relativePath.slice(0, 120)})`);
    }
    return target;
  }

  private async fetchManifest(signal?: AbortSignal): Promise<AssetManifest> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    const abortUpstream = (): void => controller.abort(signal?.reason as Error | undefined);
    signal?.addEventListener("abort", abortUpstream, { once: true });
    if (signal?.aborted) abortUpstream();
    try {
      // Independent URLs; both requests share the same launch budget. Attach
      // handlers to both immediately, including when one fails before the other.
      const [manifest, release] = await Promise.all([
        (async () => {
          const response = await this.fetchFollowingRedirects(this.feedUrl, controller.signal);
          const body = await response.text();
          if (Buffer.byteLength(body, "utf8") > MAX_FEED_BYTES) throw new Error("Feed too large");
          return parseAssetManifest(JSON.parse(stripByteOrderMark(body)));
        })(),
        this.discoverReleaseAssets ? (async (): Promise<unknown> => {
          const response = await this.fetchFollowingRedirects(this.releaseApiUrl, controller.signal, RELEASE_API_HOSTS);
          const body = await response.text();
          if (Buffer.byteLength(body, "utf8") > MAX_RELEASE_METADATA_BYTES) {
            throw manifestError("metadonnees de release GitHub trop volumineuses");
          }
          return JSON.parse(stripByteOrderMark(body)) as unknown;
        })() : Promise.resolve(null),
      ]);
      return this.discoverReleaseAssets ? mergeGitHubReleaseAssets(manifest, release) : manifest;
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortUpstream);
    }
  }

  private async fetchFollowingRedirects(
    rawUrl: string,
    signal?: AbortSignal,
    firstHopHosts: ReadonlySet<string> = ASSET_URL_HOSTS,
  ): Promise<Response> {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const allowedHosts = hop === 0 ? firstHopHosts : ASSET_REDIRECT_HOSTS;
      if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
        throw new Error(`Hôte de téléchargement d’assets non autorisé : ${url.hostname}.`);
      }
      const response = await this.fetchImpl(url.href, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error("Téléchargement d’assets refusé (redirection invalide).");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`Téléchargement d’assets refusé (HTTP ${response.status}).`);
      return response;
    }
    throw new Error("Trop de redirections pendant le téléchargement des assets.");
  }

  /**
   * Return the cache path holding the verified payload for `asset`,
   * downloading it first when the cache misses or no longer matches the
   * expected SHA-256.
   */
  private async ensureCachedAsset(
    asset: AssetManifestEntry,
    signal: AbortSignal | undefined,
    onBytes: (amount: number) => void,
  ): Promise<string> {
    await mkdir(this.cacheDirectory, { recursive: true });
    const cachePath = join(this.cacheDirectory, `${asset.sha256}.pack`);
    const cached = await stat(cachePath).catch(() => null);
    if (cached?.isFile() && cached.size === asset.size && (await sha256File(cachePath)) === asset.sha256) {
      onBytes(asset.size);
      return cachePath;
    }
    await rm(cachePath, { force: true });

    const response = await this.fetchFollowingRedirects(asset.url, signal);
    if (!response.body) throw new Error(`Téléchargement d’assets refusé (HTTP ${response.status}).`);
    const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let receivedBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > asset.size) {
          callback(new Error(`L’asset ${asset.name} dépasse la taille annoncée.`));
          return;
        }
        hash.update(chunk);
        onBytes(chunk.byteLength);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        meter,
        createWriteStream(temporaryPath, { flags: "wx" }),
        { signal },
      );
      if (receivedBytes !== asset.size || hash.digest("hex") !== asset.sha256) {
        throw new Error(`L’asset ${asset.name} est corrompu (empreinte SHA-256 inattendue).`);
      }
      await rename(temporaryPath, cachePath);
      return cachePath;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async installAsset(
    root: string,
    asset: AssetManifestEntry,
    cachePath: string,
    ownedFiles: Set<string>,
  ): Promise<InstalledAssetRecord> {
    const installedFiles: InstalledFileRecord[] = [];
    if (asset.type === "file") {
      await this.placeFile(root, asset.installPath, cachePath, ownedFiles);
      installedFiles.push({ path: asset.installPath, sha256: asset.sha256, size: asset.size });
      return { name: asset.name, version: asset.version, sha256: asset.sha256, installedFiles };
    }

    const entries = await readZipDirectory(cachePath, {
      maxEntries: MAX_ZIP_ENTRIES,
      maxEntryUncompressedBytes: MAX_ASSET_BYTES,
      maxTotalUncompressedBytes: MAX_TOTAL_ASSET_BYTES,
    });
    const packRoot = asset.installPath === "." ? "" : asset.installPath;
    // Validate every target before touching the client folder: a single bad
    // entry rejects the whole pack instead of installing it halfway.
    const files = entries
      .filter((entry) => !entry.directory)
      .map((entry) => ({
        entry,
        relativePath: validateInstallRelativePath(joinRelativePaths(packRoot, entry.name), "file"),
      }));

    if (asset.releasePackEntry) {
      const expected = asset.releasePackEntry.toLocaleLowerCase("en-US");
      if (
        files.length !== 1
        || files[0].entry.name.toLocaleLowerCase("en-US") !== expected
      ) {
        throw new Error(
          "Archive d'assets auto-decouverte invalide (" + asset.name + ") : "
          + "elle doit contenir uniquement " + asset.releasePackEntry + ".",
        );
      }
    }

    for (const { entry, relativePath } of files) {
      const target = this.resolveTarget(root, relativePath);
      const staging = join(dirname(target), `.rotk-staging-${randomUUID()}`);
      assertSafeGeneratedStagingPath(staging, target);
      try {
        const stagedHash = await extractZipEntry(cachePath, entry, staging);
        await this.backupOriginal(root, relativePath, target, ownedFiles);
        await rename(staging, target);
        installedFiles.push({ path: relativePath, sha256: stagedHash, size: entry.uncompressedSize });
        ownedFiles.add(relativePath.toLocaleLowerCase("en-US"));
      } catch (error) {
        await rm(staging, { force: true });
        throw error;
      }
    }
    return { name: asset.name, version: asset.version, sha256: asset.sha256, installedFiles };
  }

  private async placeFile(
    root: string,
    relativePath: string,
    sourcePath: string,
    ownedFiles: Set<string>,
  ): Promise<void> {
    const target = this.resolveTarget(root, relativePath);
    const staging = join(dirname(target), `.rotk-staging-${randomUUID()}`);
    assertSafeGeneratedStagingPath(staging, target);
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(sourcePath, staging, fsConstants.COPYFILE_EXCL);
      await this.backupOriginal(root, relativePath, target, ownedFiles);
      await rename(staging, target);
      ownedFiles.add(relativePath.toLocaleLowerCase("en-US"));
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }
  }

  /**
   * Keep a one-time copy of a client file the feed is about to overwrite and
   * that no previous sync installed, so "restore vanilla" can undo the feed.
   */
  private async backupOriginal(
    root: string,
    relativePath: string,
    target: string,
    ownedFiles: Set<string>,
  ): Promise<void> {
    if (ownedFiles.has(relativePath.toLocaleLowerCase("en-US"))) return;
    const existing = await stat(target).catch(() => null);
    if (!existing?.isFile()) return;
    const backupPath = join(this.backupDirectory, relativeToNative(relativePath));
    if (await exists(backupPath) || await exists(join(this.legacyBackupDirectory, relativeToNative(relativePath)))) return;
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(target, backupPath, fsConstants.COPYFILE_EXCL);
  }

  private async restoreOrRemove(root: string, relativePath: string): Promise<void> {
    const target = this.resolveTarget(root, relativePath);
    const current = join(this.backupDirectory, relativeToNative(relativePath));
    const legacy = join(this.legacyBackupDirectory, relativeToNative(relativePath));
    const backupPath = await exists(current) ? current : legacy;
    if (await exists(backupPath)) {
      await mkdir(dirname(target), { recursive: true });
      const staging = join(dirname(target), `.rotk-staging-${randomUUID()}`);
      assertSafeGeneratedStagingPath(staging, target);
      try {
        await copyFile(backupPath, staging, fsConstants.COPYFILE_EXCL);
        await rename(staging, target);
      } catch (error) {
        await rm(staging, { force: true });
        throw error;
      }
      await rm(backupPath, { force: true });
    } else {
      await rm(target, { force: true });
    }
  }

  private async writeState(state: AssetSyncState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, this.statePath);
  }

  /** Move still-current packs out of the old userData cache instead of downloading them again. */
  private async adoptLegacyCache(manifest: AssetManifest): Promise<void> {
    if (this.legacyCacheDirectory === this.cacheDirectory) return;
    const entries = await readdir(this.legacyCacheDirectory).catch(() => [] as string[]);
    if (entries.length === 0) return;
    const keep = new Set(manifest.assets.map((asset) => `${asset.sha256}.pack`));
    await mkdir(this.cacheDirectory, { recursive: true });
    for (const entry of entries) {
      const from = join(this.legacyCacheDirectory, entry);
      const to = join(this.cacheDirectory, entry);
      if (!keep.has(entry) || await exists(to)) continue;
      // Anything not moved stays in the old cache for the next sync.
      await moveFile(from, to, async (copy) => await sha256File(copy) === entry.slice(0, 64));
    }
  }

  /** Move backups made by older launchers next to the install too, so C: gets its space back. */
  private async adoptLegacyBackups(): Promise<void> {
    if (this.legacyBackupDirectory === this.backupDirectory) return;
    const entries = await readdir(this.legacyBackupDirectory, { recursive: true, withFileTypes: true })
      .catch(() => []);
    if (entries.length === 0) return;
    let leftOver = false;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const from = join(entry.parentPath, entry.name);
      const to = join(this.backupDirectory, relative(this.legacyBackupDirectory, from));
      let moved = false;
      if (!(await exists(to))) {
        try {
          const { size } = await stat(from);
          await mkdir(dirname(to), { recursive: true });
          moved = await moveFile(from, to, async (copy) => (await stat(copy)).size === size);
        } catch {
          // Left in place: still restored from the old folder (see restoreOrRemove).
        }
      }
      if (!moved) leftOver = true;
    }
    if (!leftOver) await rm(this.legacyBackupDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async pruneCache(manifest: AssetManifest): Promise<void> {
    const keep = new Set(manifest.assets.map((asset) => `${asset.sha256}.pack`));
    try {
      for (const entry of await readdir(this.cacheDirectory)) {
        if (!keep.has(entry)) await rm(join(this.cacheDirectory, entry), { force: true });
      }
    } catch {
      // Cache pruning is best-effort housekeeping.
    }
    // Old cache: only drop what no current pack uses. Anything that could not
    // be moved yet stays for the next sync.
    if (this.legacyCacheDirectory !== this.cacheDirectory) {
      const legacy = await readdir(this.legacyCacheDirectory).catch(() => [] as string[]);
      for (const entry of legacy) {
        if (!keep.has(entry)) await rm(join(this.legacyCacheDirectory, entry), { force: true }).catch(() => undefined);
      }
      await rmdir(this.legacyCacheDirectory).catch(() => undefined); // only when empty
    }
  }
}

export const assetSyncInternals = {
  parseAssetManifest,
  validateInstallRelativePath,
  MAX_ASSET_BYTES,
  MAX_TOTAL_ASSET_BYTES,
};
