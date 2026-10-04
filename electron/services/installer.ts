import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises";
import { retryFs } from "./fs-safe.js";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { InstallProgress } from "../../shared/contracts.js";
import {
  CRITICAL_CLIENT_FILES,
  INSTALL_MARKER_NAME,
} from "../constants.js";
import {
  assertSafeGeneratedStagingPath,
  validateClientSource,
  validateInstallDestination,
} from "./path-policy.js";
import { identifyClientBuild } from "./client-build.js";
import { deployVivoxCompatibility } from "./vivox-client.js";

const MAX_CLIENT_FILES = 250_000;
const MINIMUM_DISK_HEADROOM = 2 * 1024 * 1024 * 1024;

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

export async function readInstallationMarker(root: string): Promise<InstallationMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, INSTALL_MARKER_NAME), "utf8"));
    return isInstallationMarker(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
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
  const disk = await statfs(parent);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  const headroom = Math.max(MINIMUM_DISK_HEADROOM, Math.ceil(requiredBytes * 0.1));
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes + headroom) {
    throw new Error(
      `Espace disque insuffisant : ${Math.ceil((requiredBytes + headroom) / 1024 ** 3)} Go sont nécessaires.`,
    );
  }
}

async function copyOnce(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function copyWithProgress(
  source: SourceFile,
  targetPath: string,
  signal: AbortSignal,
  onBytes: (amount: number) => void,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.byteLength);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source.absolutePath),
    meter,
    createWriteStream(targetPath, { flags: "wx" }),
    { signal },
  );
  await utimes(targetPath, source.modifiedAt, source.modifiedAt);
}

async function patchBattlEye(stagingRoot: string): Promise<void> {
  const configPath = join(stagingRoot, "BattlEye", "BEClient_x64.cfg");
  try {
    const current = await readFile(configPath, "utf8");
    const patched = current.replace(/MasterPort\s+\d+/i, "MasterPort 20099");
    if (patched !== current) {
      await copyOnce(configPath, `${configPath}.original`);
      await writeFile(configPath, patched, "ascii");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function deployOpenSourceShim(stagingRoot: string, shimPath: string): Promise<void> {
  await access(shimPath, fsConstants.R_OK);
  const activePath = join(stagingRoot, "steam_api64.dll");
  const originalPath = join(stagingRoot, "steam_api64.original.dll");
  await copyOnce(activePath, originalPath);
  await retryFs(() => copyFile(shimPath, activePath));
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
    currentFile: "Analyse du client H1Z1",
  });

  const criticalHashes: Record<string, string> = {};
  for (const fileName of CRITICAL_CLIENT_FILES) {
    criticalHashes[fileName] = await sha256(join(root, fileName));
  }
  const executable = await stat(join(root, "H1Z1.exe"));
  const clientBuild = identifyClientBuild(executable.size, criticalHashes["H1Z1.exe"]);

  request.onProgress({
    phase: "configuring",
    completedBytes: totalFiles,
    totalBytes: totalFiles,
    filesCompleted: totalFiles,
    totalFiles,
    currentFile: "Application du client ROTK",
  });

  await copyOnce(join(root, "ClientConfig.ini"), join(root, "ClientConfig.original.ini"));
  await deployOpenSourceShim(root, request.shimPath);
  await deployVivoxCompatibility(
    root,
    request.vivoxProxyPath,
    request.vivoxRuntimePath,
  );
  await patchBattlEye(root);

  const marker: InstallationMarker = {
    schemaVersion: 1,
    installId: existingMarker?.installId ?? randomUUID(),
    clientBuildId: clientBuild.id,
    sourceRoot: existingMarker?.sourceRoot ?? root,
    installedAt: existingMarker?.installedAt ?? new Date().toISOString(),
    launcherVersion: request.launcherVersion,
    patchVersion: "nosteam-shim-1+vivox5-compat-1+crouch-parity-v12+shotgun-sprint-v3",
    criticalHashes,
  };
  const markerPath = join(root, INSTALL_MARKER_NAME);
  const temporaryMarkerPath = join(root, `${INSTALL_MARKER_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporaryMarkerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await retryFs(() => rename(temporaryMarkerPath, markerPath));

  request.onProgress({
    phase: "finalizing",
    completedBytes: totalFiles,
    totalBytes: totalFiles,
    filesCompleted: totalFiles,
    totalFiles,
    currentFile: "Client isolé prêt",
  });
  return marker;
}

async function safeCleanup(staging: string, destination: string): Promise<void> {
  assertSafeGeneratedStagingPath(staging, destination);
  await rm(staging, { recursive: true, force: true });
}

export async function installClient(request: InstallRequest): Promise<InstallationMarker> {
  const sourceRoot = await validateClientSource(request.sourceRoot);
  const destinationRoot = await validateInstallDestination(request.destinationRoot, sourceRoot);
  const destinationParent = dirname(destinationRoot);
  await mkdir(destinationParent, { recursive: true });

  const existingDestination = await stat(destinationRoot).catch(() => null);
  if (existingDestination) {
    throw new Error("Le dossier ROTK existe déjà. Choisis un nouvel emplacement vide.");
  }

  request.onProgress({
    phase: "scanning",
    completedBytes: 0,
    totalBytes: 0,
    filesCompleted: 0,
    totalFiles: 0,
    currentFile: "Analyse du client H1Z1",
  });
  const files = await enumerateSource(sourceRoot, request.signal);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  await ensureDiskSpace(destinationParent, totalBytes);

  const sourceCriticalHashes: Record<string, string> = {};
  for (const fileName of CRITICAL_CLIENT_FILES) {
    sourceCriticalHashes[fileName] = await sha256(join(sourceRoot, fileName));
  }
  const executable = files.find((file) => file.relativePath.toLocaleLowerCase("en-US") === "h1z1.exe");
  if (!executable) throw new Error("H1Z1.exe a disparu pendant l’analyse du client.");
  const clientBuild = identifyClientBuild(executable.size, sourceCriticalHashes["H1Z1.exe"]);

  const stagingRoot = join(destinationParent, `.rotk-staging-${randomUUID()}`);
  assertSafeGeneratedStagingPath(stagingRoot, destinationRoot);
  await mkdir(stagingRoot, { recursive: false });

  let completedBytes = 0;
  let filesCompleted = 0;
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

  try {
    // Keep post-creation validation inside the cleanup boundary. In particular,
    // a junction race must not leave a reusable staging directory behind.
    await validateInstallDestination(stagingRoot, sourceRoot);
    for (const source of files) {
      emitCopyProgress(source.relativePath, true);
      const targetPath = join(stagingRoot, source.relativePath);
      await copyWithProgress(source, targetPath, request.signal, (amount) => {
        completedBytes += amount;
        emitCopyProgress(source.relativePath);
      });
      const copiedFile = await stat(targetPath);
      if (!copiedFile.isFile() || copiedFile.size !== source.size) {
        throw new Error(`La taille copiée de ${source.relativePath} ne correspond pas à la source.`);
      }
      filesCompleted += 1;
    }

    request.onProgress({
      phase: "verifying",
      completedBytes,
      totalBytes,
      filesCompleted,
      totalFiles: files.length,
      currentFile: "Vérification SHA-256",
    });
    for (const fileName of CRITICAL_CLIENT_FILES) {
      const destinationHash = await sha256(join(stagingRoot, fileName));
      if (destinationHash !== sourceCriticalHashes[fileName]) {
        throw new Error(`La copie de ${fileName} ne correspond pas à la source.`);
      }
      const sourceHashAfterCopy = await sha256(join(sourceRoot, fileName));
      if (sourceHashAfterCopy !== sourceCriticalHashes[fileName]) {
        throw new Error(`Le fichier source ${fileName} a changé pendant la copie.`);
      }
    }

    request.onProgress({
      phase: "configuring",
      completedBytes,
      totalBytes,
      filesCompleted,
      totalFiles: files.length,
      currentFile: "Application du client ROTK",
    });
    await copyFile(join(stagingRoot, "ClientConfig.ini"), join(stagingRoot, "ClientConfig.original.ini"));
    await deployOpenSourceShim(stagingRoot, request.shimPath);
    await deployVivoxCompatibility(
      stagingRoot,
      request.vivoxProxyPath,
      request.vivoxRuntimePath,
    );
    await patchBattlEye(stagingRoot);

    const marker: InstallationMarker = {
      schemaVersion: 1,
      installId: randomUUID(),
      clientBuildId: clientBuild.id,
      sourceRoot,
      installedAt: new Date().toISOString(),
      launcherVersion: request.launcherVersion,
      patchVersion: "nosteam-shim-1+vivox5-compat-1+crouch-parity-v12+shotgun-sprint-v3",
      criticalHashes: sourceCriticalHashes,
    };
    await writeFile(join(stagingRoot, INSTALL_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });

    request.onProgress({
      phase: "finalizing",
      completedBytes,
      totalBytes,
      filesCompleted,
      totalFiles: files.length,
      currentFile: "Finalisation atomique",
    });
    await retryFs(() => rename(stagingRoot, destinationRoot));
    return marker;
  } catch (error) {
    await safeCleanup(stagingRoot, destinationRoot).catch(() => undefined);
    throw error;
  }
}

export const installerInternals = {
  enumerateSource,
  ensureDiskSpace,
  sha256,
  safeCleanup,
};
