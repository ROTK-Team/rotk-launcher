import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  utimes,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallProgress } from "../../shared/contracts.js";
import {
  CRITICAL_CLIENT_FILES,
  INSTALL_MARKER_NAME,
  INSTALL_PENDING_MARKER_NAME,
} from "../constants.js";
import {
  PathPolicyError,
  assertSafeGeneratedStagingPath,
  validateClientSource,
  validateInstallDestination,
} from "./path-policy.js";
import { identifyClientBuild } from "./client-build.js";
import { deployVivoxCompatibility } from "./vivox-client.js";
import {
  assertExecutableNotRunning,
  atomicCopyFile,
  atomicWriteFile,
  installFileIfChanged,
  retryFs,
  sha256File,
} from "./fs-safe.js";

const MAX_CLIENT_FILES = 250_000;
const MINIMUM_DISK_HEADROOM = 2 * 1024 * 1024 * 1024;
// ponytail: fixed at 3, enough to keep small files moving next to a big pack
// without thrashing an HDD. Tune if HDD installs get slower.
const COPY_CONCURRENCY = 3;
// Big buffers make a stream copy as fast as CopyFileW, and unlike CopyFileW it
// can be cancelled and reports progress while a 2 GB pack is copied.
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;
// Files the game rewrites for the player; an existing copy is never replaced.
const PLAYER_FILES = new Set(["useroptions.ini", "inputprofile_user.xml"]);
const PARTIAL_SUFFIX = ".rotk-part";
// NTFS, utimes and FAT don't share the same mtime precision.
const MTIME_TOLERANCE_MS = 2_000;
export const CLIENT_PATCH_VERSION = "nosteam-shim-1+vivox5-compat-1+crouch-parity-v12+shotgun-sprint-v3";

interface SourceFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  modifiedAt: Date;
}

export interface InstallationMarker {
  schemaVersion: 1;
  installId: string;
  clientBuildId: string;
  sourceRoot: string;
  installedAt: string;
  launcherVersion: string;
  patchVersion: string;
  criticalHashes: Record<string, string>;
}

interface PendingInstallMarker {
  schemaVersion: 1;
  installId: string;
  sourceRoot: string;
  startedAt: string;
}

export interface InstallRequest {
  sourceRoot: string;
  destinationRoot: string;
  shimPath: string;
  vivoxProxyPath: string;
  vivoxRuntimePath: string;
  launcherVersion: string;
  signal: AbortSignal;
  onProgress(progress: InstallProgress): void;
}

export interface AdoptExistingClientRequest {
  root: string;
  shimPath: string;
  vivoxProxyPath: string;
  vivoxRuntimePath: string;
  launcherVersion: string;
  onProgress(progress: InstallProgress): void;
}

function isInstallationMarker(value: unknown): value is InstallationMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<InstallationMarker>;
  return marker.schemaVersion === 1
    && typeof marker.installId === "string"
    && marker.installId.length > 0
    && typeof marker.clientBuildId === "string"
    && typeof marker.sourceRoot === "string"
    && typeof marker.installedAt === "string"
    && typeof marker.launcherVersion === "string"
    && typeof marker.patchVersion === "string"
    && marker.criticalHashes !== null
    && typeof marker.criticalHashes === "object";
}

function isPendingMarker(value: unknown): value is PendingInstallMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<PendingInstallMarker>;
  return marker.schemaVersion === 1
    && typeof marker.installId === "string"
    && marker.installId.length > 0
    && typeof marker.sourceRoot === "string"
    && typeof marker.startedAt === "string";
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readInstallationMarker(root: string): Promise<InstallationMarker | null> {
  const parsed = await readJson(join(root, INSTALL_MARKER_NAME));
  return isInstallationMarker(parsed) ? parsed : null;
}

async function readPendingMarker(root: string): Promise<PendingInstallMarker | null> {
  const parsed = await readJson(join(root, INSTALL_PENDING_MARKER_NAME));
  return isPendingMarker(parsed) ? parsed : null;
}

export type DestinationState = "absent" | "empty" | "pending" | "installed" | "foreign";

export async function inspectDestination(root: string): Promise<DestinationState> {
  const details = await stat(root).catch(() => null);
  if (!details) return "absent";
  if (!details.isDirectory()) return "foreign";
  if (await readInstallationMarker(root)) return "installed";
  if (await readPendingMarker(root)) return "pending";
  return (await readdir(root)).length === 0 ? "empty" : "foreign";
}

async function enumerateSource(root: string, signal: AbortSignal): Promise<SourceFile[]> {
  const files: SourceFile[] = [];

  async function visit(relativeDirectory: string): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("Installation annulée");
    const absoluteDirectory = join(root, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      const absolutePath = join(root, relativePath);
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) {
        throw new Error(`Le client source contient une jonction non sûre : ${relativePath}`);
      }
      if (details.isDirectory()) {
        await visit(relativePath);
      } else if (details.isFile()) {
        files.push({
          relativePath,
          absolutePath,
          size: details.size,
          modifiedAt: details.mtime,
        });
        if (files.length > MAX_CLIENT_FILES) {
          throw new Error("Le dossier source contient un nombre anormal de fichiers.");
        }
      } else {
        throw new Error(`Type de fichier source non pris en charge : ${relativePath}`);
      }
    }
  }

  await visit("");
  return files;
}

async function ensureDiskSpace(parent: string, requiredBytes: number): Promise<void> {
  if (requiredBytes === 0) return;
  const disk = await statfs(parent);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  const headroom = Math.max(MINIMUM_DISK_HEADROOM, Math.ceil(requiredBytes * 0.1));
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes + headroom) {
    throw new Error(
      `Espace disque insuffisant : ${Math.ceil((requiredBytes + headroom) / 1024 ** 3)} Go sont nécessaires.`,
    );
  }
}

// Skip files an earlier run already copied. When repairing a finished install,
// only missing files are copied: the others may be ROTK assets or patches.
async function needsCopy(source: SourceFile, targetPath: string, onlyMissing = false): Promise<boolean> {
  const target = await stat(targetPath).catch(() => null);
  if (!target?.isFile()) return true;
  if (onlyMissing || PLAYER_FILES.has(source.relativePath.toLocaleLowerCase("en-US"))) return false;
  return target.size !== source.size
    || Math.abs(target.mtimeMs - source.modifiedAt.getTime()) > MTIME_TOLERANCE_MS;
}

async function copyClientFile(
  source: SourceFile,
  targetPath: string,
  signal: AbortSignal,
  onBytes: (amount: number) => void,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const partialPath = `${targetPath}${PARTIAL_SUFFIX}`;
  await rm(partialPath, { force: true });
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.byteLength);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source.absolutePath, { highWaterMark: COPY_CHUNK_BYTES }),
    meter,
    createWriteStream(partialPath, { highWaterMark: COPY_CHUNK_BYTES }),
    { signal },
  );
  // Same mtime as the source so a resumed install can skip it.
  await retryFs(() => utimes(partialPath, source.modifiedAt, source.modifiedAt));
  await retryFs(() => rename(partialPath, targetPath));
  const copied = await stat(targetPath);
  if (!copied.isFile() || copied.size !== source.size) {
    throw new Error(`La taille copiée de ${source.relativePath} ne correspond pas à la source.`);
  }
}

// Backups are kept forever, so a crash must never leave a truncated one.
async function copyOnce(source: string, destination: string): Promise<void> {
  if (await stat(destination).then(() => true, () => false)) return;
  await atomicCopyFile(source, destination);
}

async function patchBattlEye(root: string): Promise<void> {
  const configPath = join(root, "BattlEye", "BEClient_x64.cfg");
  const current = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current === null) return;
  const patched = current.replace(/MasterPort\s+\d+/i, "MasterPort 20099");
  if (patched === current) return;
  await copyOnce(configPath, `${configPath}.original`);
  await atomicWriteFile(configPath, patched);
}

async function deployOpenSourceShim(root: string, shimPath: string): Promise<void> {
  const activePath = join(root, "steam_api64.dll");
  await copyOnce(activePath, join(root, "steam_api64.original.dll"));
  await installFileIfChanged(shimPath, activePath);
}

// Shared by install, resume and adoption. Every step is idempotent.
async function applyClientPatches(
  root: string,
  request: Pick<InstallRequest, "shimPath" | "vivoxProxyPath" | "vivoxRuntimePath">,
): Promise<void> {
  await assertExecutableNotRunning(join(root, "H1Z1.exe"));
  await copyOnce(join(root, "ClientConfig.ini"), join(root, "ClientConfig.original.ini"));
  await deployOpenSourceShim(root, request.shimPath);
  await deployVivoxCompatibility(root, request.vivoxProxyPath, request.vivoxRuntimePath);
  await patchBattlEye(root);
}

async function hashCriticalFiles(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const fileName of CRITICAL_CLIENT_FILES) hashes[fileName] = await sha256File(join(root, fileName));
  return hashes;
}

export async function adoptExistingClient(
  request: AdoptExistingClientRequest,
): Promise<InstallationMarker> {
  const sourceRoot = await validateClientSource(request.root);
  const root = await validateInstallDestination(sourceRoot);
  const existingMarker = await readInstallationMarker(root);
  const totalFiles = CRITICAL_CLIENT_FILES.length;

  request.onProgress({
    phase: "scanning",
    completedBytes: 0,
    totalBytes: totalFiles,
    filesCompleted: 0,
    totalFiles,
    currentFile: "",
  });

  const criticalHashes = await hashCriticalFiles(root);
  const executable = await stat(join(root, "H1Z1.exe"));
  const clientBuild = identifyClientBuild(executable.size, criticalHashes["H1Z1.exe"]);

  request.onProgress({
    phase: "configuring",
    completedBytes: totalFiles,
    totalBytes: totalFiles,
    filesCompleted: totalFiles,
    totalFiles,
    currentFile: "",
  });
  await applyClientPatches(root, request);

  const marker: InstallationMarker = {
    schemaVersion: 1,
    installId: existingMarker?.installId ?? randomUUID(),
    clientBuildId: clientBuild.id,
    sourceRoot: existingMarker?.sourceRoot ?? root,
    installedAt: existingMarker?.installedAt ?? new Date().toISOString(),
    launcherVersion: request.launcherVersion,
    patchVersion: CLIENT_PATCH_VERSION,
    criticalHashes,
  };
  await atomicWriteFile(join(root, INSTALL_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);

  request.onProgress({
    phase: "finalizing",
    completedBytes: totalFiles,
    totalBytes: totalFiles,
    filesCompleted: totalFiles,
    totalFiles,
    currentFile: "",
  });
  return marker;
}

// Leftovers from launchers <= 2.0.23, which copied into a staging folder.
async function removeLegacyStagingDirectories(destinationRoot: string): Promise<void> {
  const parent = dirname(destinationRoot);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".rotk-staging-")) continue;
    const staging = join(parent, entry.name);
    assertSafeGeneratedStagingPath(staging, destinationRoot);
    await retryFs(() => rm(staging, { recursive: true, force: true })).catch(() => undefined);
  }
}

// Copies the Steam client straight into the destination. No staging folder and
// no final rename (antivirus made that rename fail with EPERM, issue #68).
// The pending marker claims the folder, the install marker is written last, and
// an interrupted install picks up where it stopped.
export async function installClient(request: InstallRequest): Promise<InstallationMarker> {
  const sourceRoot = await validateClientSource(request.sourceRoot);
  const destinationRoot = await validateInstallDestination(request.destinationRoot, sourceRoot);

  const state = await inspectDestination(destinationRoot);
  if (state === "foreign") {
    throw new PathPolicyError(
      "Le dossier ROTK choisi contient déjà d’autres fichiers. Choisis un dossier vide.",
    );
  }
  // Installing onto a finished ROTK client repairs it: missing files come
  // back from the source, patches are checked, the install id is kept.
  const existingMarker = state === "installed" ? await readInstallationMarker(destinationRoot) : null;
  const repairing = existingMarker !== null;

  await mkdir(destinationRoot, { recursive: true });
  await removeLegacyStagingDirectories(destinationRoot);
  const pending = (await readPendingMarker(destinationRoot)) ?? {
    schemaVersion: 1 as const,
    installId: existingMarker?.installId ?? randomUUID(),
    sourceRoot,
    startedAt: new Date().toISOString(),
  };
  if (!repairing) {
    await atomicWriteFile(
      join(destinationRoot, INSTALL_PENDING_MARKER_NAME),
      `${JSON.stringify({ ...pending, sourceRoot }, null, 2)}\n`,
    );
  }

  request.onProgress({
    phase: "scanning",
    completedBytes: 0,
    totalBytes: 0,
    filesCompleted: 0,
    totalFiles: 0,
    currentFile: "",
  });
  const files = await enumerateSource(sourceRoot, request.signal);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const sourceCriticalHashes = await hashCriticalFiles(sourceRoot);
  const executable = files.find((file) => file.relativePath.toLocaleLowerCase("en-US") === "h1z1.exe");
  if (!executable) throw new Error("H1Z1.exe a disparu pendant l’analyse du client.");
  const clientBuild = identifyClientBuild(executable.size, sourceCriticalHashes["H1Z1.exe"]);

  const toCopy: SourceFile[] = [];
  let completedBytes = 0;
  let filesCompleted = 0;
  for (const file of files) {
    if (await needsCopy(file, join(destinationRoot, file.relativePath), repairing)) {
      toCopy.push(file);
    } else {
      completedBytes += file.size;
      filesCompleted += 1;
    }
  }
  await ensureDiskSpace(destinationRoot, toCopy.reduce((sum, file) => sum + file.size, 0));

  let lastProgressAt = 0;
  const emitCopyProgress = (currentFile: string, force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 80) return;
    lastProgressAt = now;
    request.onProgress({
      phase: "copying",
      completedBytes,
      totalBytes,
      filesCompleted,
      totalFiles: files.length,
      currentFile,
    });
  };

  // Biggest files first, small ones fill the other lanes.
  const queue = [...toCopy].sort((left, right) => right.size - left.size);
  const worker = async (): Promise<void> => {
    try {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (request.signal.aborted) throw request.signal.reason ?? new Error("Installation annulée");
        emitCopyProgress(next.relativePath);
        await copyClientFile(next, join(destinationRoot, next.relativePath), request.signal, (amount) => {
          completedBytes += amount;
          emitCopyProgress(next.relativePath);
        });
        filesCompleted += 1;
        emitCopyProgress(next.relativePath, true);
      }
    } catch (error) {
      queue.length = 0; // stop the other lanes after their current file
      throw error;
    }
  };
  const lanes = Array.from({ length: Math.min(COPY_CONCURRENCY, queue.length) }, worker);
  const outcomes = await Promise.allSettled(lanes);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure) throw failure.reason;
  emitCopyProgress("", true);
  const throwIfCancelled = (): void => {
    if (request.signal.aborted) throw request.signal.reason ?? new Error("Installation annulée");
  };
  throwIfCancelled();

  request.onProgress({
    phase: "verifying",
    completedBytes,
    totalBytes,
    filesCompleted,
    totalFiles: files.length,
    currentFile: "",
  });
  const copiedNow = new Set(toCopy.map((file) => file.relativePath.toLocaleLowerCase("en-US")));
  for (const fileName of CRITICAL_CLIENT_FILES) {
    if (fileName === "ClientConfig.ini") continue; // rewritten on every launch
    // A repaired client keeps its patched DLLs; the patch step checks them.
    if (repairing && !copiedNow.has(fileName.toLocaleLowerCase("en-US"))) continue;
    if (await sha256File(join(destinationRoot, fileName)) !== sourceCriticalHashes[fileName]) {
      throw new Error(`La copie de ${fileName} ne correspond pas à la source.`);
    }
    if (await sha256File(join(sourceRoot, fileName)) !== sourceCriticalHashes[fileName]) {
      throw new Error(`Le fichier source ${fileName} a changé pendant la copie.`);
    }
  }

  throwIfCancelled();
  request.onProgress({
    phase: "configuring",
    completedBytes,
    totalBytes,
    filesCompleted,
    totalFiles: files.length,
    currentFile: "",
  });
  await applyClientPatches(destinationRoot, request);

  const marker: InstallationMarker = {
    schemaVersion: 1,
    installId: pending.installId,
    clientBuildId: clientBuild.id,
    sourceRoot: existingMarker?.sourceRoot ?? sourceRoot,
    installedAt: existingMarker?.installedAt ?? new Date().toISOString(),
    launcherVersion: request.launcherVersion,
    patchVersion: CLIENT_PATCH_VERSION,
    criticalHashes: existingMarker?.criticalHashes ?? sourceCriticalHashes,
  };
  request.onProgress({
    phase: "finalizing",
    completedBytes,
    totalBytes,
    filesCompleted,
    totalFiles: files.length,
    currentFile: "",
  });
  await atomicWriteFile(join(destinationRoot, INSTALL_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);
  await retryFs(() => rm(join(destinationRoot, INSTALL_PENDING_MARKER_NAME), { force: true }))
    .catch(() => undefined);
  return marker;
}

const LEFTOVER_FILE = /^\.rotk-staging-|\.rotk-part$|\.rotk-[0-9a-f-]{36}\.tmp$/i;

/**
 * Remove what interrupted runs left behind around an install: staging
 * folders of launchers <= 2.0.23 next to it (up to 17 GB each) and
 * temporary files in the folders the launcher writes to. Best-effort.
 */
export async function cleanupInstallLeftovers(root: string): Promise<void> {
  await removeLegacyStagingDirectories(root);
  for (const directory of [root, join(root, "Resources", "Assets")]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && LEFTOVER_FILE.test(entry.name)) {
        await rm(join(directory, entry.name), { force: true }).catch(() => undefined);
      }
    }
  }
}

export const installerInternals = {
  enumerateSource,
  ensureDiskSpace,
  needsCopy,
  removeLegacyStagingDirectories,
  COPY_CONCURRENCY,
};
