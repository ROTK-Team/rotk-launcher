import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { atomicCopyFile } from "./fs-safe.js";

const STEAM_SHIM_FILE_NAME = "steam_api64.dll";

const INVALID_BUNDLED_SHIM_ERROR =
  "Le shim Steam ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.";
const SHIM_COPY_ERROR = "Le shim Steam ROTK n'a pas été copié correctement.";

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function fileHash(filePath: string): Promise<string> {
  return sha256(filePath).catch(() => "");
}

/** An unreadable bundle hashes to "", which must never match an absent shim. */
async function bundledShimHash(bundledShimPath: string): Promise<string> {
  const digest = await fileHash(bundledShimPath);
  if (!digest) throw new Error(INVALID_BUNDLED_SHIM_ERROR);
  return digest;
}

/**
 * Brings the installed steam_api64.dll to the shim this launcher ships. The
 * install and adoption paths only copy it once, so this launch-time pass is
 * how an existing install receives the shim of a launcher update. A shim that
 * already matches is left untouched: rewriting it would change its mtime,
 * invalidating the integrity hash cache and waking the antivirus for nothing.
 */
export async function deploySteamShim(
  root: string,
  bundledShimPath: string,
): Promise<void> {
  const expected = await bundledShimHash(bundledShimPath);
  const activePath = join(root, STEAM_SHIM_FILE_NAME);
  if (await fileHash(activePath) === expected) return;
  await atomicCopyFile(bundledShimPath, activePath);
  if (await fileHash(activePath) !== expected) {
    throw new Error(SHIM_COPY_ERROR);
  }
}

/** Re-read the installed shim before spawn; never repair after attestation. */
export async function assertSteamShim(
  root: string,
  bundledShimPath: string,
): Promise<void> {
  const expected = await bundledShimHash(bundledShimPath);
  if (await fileHash(join(root, STEAM_SHIM_FILE_NAME)) !== expected) {
    throw new Error(SHIM_COPY_ERROR);
  }
}

export const steamShimInternals = {
  sha256,
};
