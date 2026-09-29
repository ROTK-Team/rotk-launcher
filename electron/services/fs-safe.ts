import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Antivirus, indexer and sync clients hold freshly written files for a moment,
// so rename/replace/delete can fail with EPERM/EBUSY/EACCES. Retry those.

const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// About 7 s in total with the defaults.
export async function retryFs<T>(
  operation: () => Promise<T>,
  { attempts = 8, baseDelayMs = 100, maxDelayMs = 2_000 }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_CODES.has(code) || attempt >= attempts) throw error;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)));
    }
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function atomicCopyFile(source: string, target: string): Promise<void> {
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  try {
    await retryFs(() => copyFile(source, temporary));
    await retryFs(() => rename(temporary, target));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteFile(
  target: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding, flag: "wx" });
    await retryFs(() => rename(temporary, target));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// Only writes when the content differs, so a healthy install is left alone.
export async function installFileIfChanged(source: string, target: string): Promise<boolean> {
  const [sourceStat, targetStat] = await Promise.all([
    stat(source),
    stat(target).catch(() => null),
  ]);
  if (
    targetStat?.isFile()
    && targetStat.size === sourceStat.size
    && await sha256File(target) === await sha256File(source)
  ) {
    return false;
  }
  await atomicCopyFile(source, target);
  return true;
}

// A running exe can't be opened for writing (EBUSY). Catches a game left open
// by a previous launcher session, which GameLauncher.isRunning() can't see.
export async function assertExecutableNotRunning(executablePath: string, attempts = 5): Promise<void> {
  // An antivirus scan can hold the exe for a moment too; a running game stays busy.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await (await open(executablePath, "r+")).close();
      return;
    } catch (error) {
      // Missing or read-only executables are reported by the regular checks.
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") return;
      if (attempt >= attempts) throw new Error("H1Z1 est déjà lancé depuis cette installation.");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * 2 ** (attempt - 1)));
    }
  }
}

// Keep the file path and a likely cause in the message shown to the player.
export function describeSystemError(
  error: NodeJS.ErrnoException,
  bundledResourcesRoot: string | null,
): string {
  const code = error.code ?? "UNKNOWN";
  const path = error.path ?? "";
  const operation = error.syscall ? `, ${error.syscall}` : "";
  const bundled = Boolean(
    bundledResourcesRoot
    && path
    && resolve(path).toLocaleLowerCase("en-US").startsWith(
      `${resolve(bundledResourcesRoot).toLocaleLowerCase("en-US")}${sep}`,
    ),
  );
  if (!path) return `Erreur système (${code}${operation}).`;
  if (code === "ENOENT" && bundled) {
    return `Un fichier du launcher a disparu : ${path}. Ton antivirus l’a probablement mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.`;
  }
  if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
    return `Accès refusé au fichier ${path} (${code}${operation}). Un antivirus, H1Z1 ou un autre programme l’utilise : réessaie, ou ajoute le dossier ROTK aux exclusions de l’antivirus.`;
  }
  if (code === "ENOSPC") {
    return `Disque plein pendant l’écriture de ${path}. Libère de l’espace puis réessaie.`;
  }
  if (code === "ENOENT") {
    return `Fichier introuvable : ${path}.`;
  }
  return `Erreur système (${code}${operation}) : ${path}.`;
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return error instanceof Error && typeof code === "string" && /^E[A-Z0-9_]+$/.test(code);
}
