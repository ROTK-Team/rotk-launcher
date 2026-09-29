import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { retryFs } from "./fs-safe.js";
import { dirname, join } from "node:path";
import { SUPPORTED_CLIENT_BUILDS } from "./client-build.js";

export const GAMEPLAY_PATCH_FILE_NAME = "dinput8.dll";
export const GAMEPLAY_PATCH_SHA256 =
  "2c8c7d65f8410a2f05f58318978b44f08860c4f5647b5474a11bf70a0ebc0b3a";
export const GAMEPLAY_PATCH_BYTES = 34_304;

/**
 * Marker next to H1Z1.exe. The proxy enables the sprint byte pair and guarded
 * stance hooks only with this exact mode and patch list. Removing it disables
 * stance behavior and restores the sprint bytes within two seconds; dormant
 * trampolines and the CZ continuation-address repair remain until the game
 * exits. Full removal requires a restart.
 */
export const GAMEPLAY_MARKER_FILE_NAME = "rotk-shotgun-sprint.ini";

/** Exact retired ROTK artifacts an automatic migration may replace. */
export const RETIRED_GAMEPLAY_PATCHES = Object.freeze([
  Object.freeze({
    // Local v17 before the CZ continuation-address repair.
    sha256: "f27379c09f04db9abbeeaee56a0231fe7aeaa2e9570e670091c75a85871e67db",
    bytes: 33_792,
  }),
  Object.freeze({
    // v16 physical mouse polling -> v17 configured Infantry actions.
    sha256: "6ca1a0b1c28f8d11482a416e9f9d8b6330db253a78ed79b9301ec31198ce7845",
    bytes: 33_792,
  }),
  Object.freeze({ sha256: "36fba2037b0c9b1829e7c7e8bbedbcf5a962f495de4e8c63880b785745dcac3a", bytes: 25_088 }),
  Object.freeze({
    // Launcher 1.4.3, retired in 1.4.4 after the crash reports.
    sha256: "307603aaebdebf52fa55ad0a7337abd785e5190d1bf71e07520240fed51fbd7a",
    bytes: 24_064,
  }),
  Object.freeze({
    // Launcher 1.4.5/1.4.7 stable one-byte proxy. Proven insufficient on
    // 2026-09-12: a pending enter-fire event still blocked sprint.
    sha256: "0d5603169fe86f874f9d6059a4f62a10b41d4dce31849561b59f0dc75e21a109",
    bytes: 21_504,
  }),
]);

const GAMEPLAY_CLIENT_BUILD_ID = "h1z1-1.0.326.439939";
const GAMEPLAY_CLIENT_BUILD = SUPPORTED_CLIENT_BUILDS.find(
  (build) => build.id === GAMEPLAY_CLIENT_BUILD_ID,
);
if (!GAMEPLAY_CLIENT_BUILD) {
  throw new Error("The gameplay patch has no matching supported H1Z1 build");
}

const STATE_FILE_NAME = "gameplay-patch-state.v1.json";

const UNKNOWN_DINPUT_ERROR =
  "Un dinput8.dll inconnu est présent dans le client ROTK. Supprime-le ou réimporte un client propre.";
const INVALID_BUNDLED_PATCH_ERROR =
  "Le patch sprint ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.";
const UNSUPPORTED_CLIENT_ERROR =
  "Cette version de H1Z1 n’est pas compatible avec le patch sprint ROTK. Vérifie les fichiers du jeu dans Steam puis réessaie.";
const INSTALL_PATCH_ERROR =
  "Le patch sprint ROTK n’a pas pu être installé. Ferme H1Z1 puis réessaie.";
const REMOVE_PATCH_ERROR =
  "Le patch sprint ROTK n’a pas pu être supprimé. Ferme H1Z1 puis réessaie.";
const MARKER_ERROR =
  "Le marqueur du patch sprint ROTK n’a pas pu être écrit. Ferme H1Z1 puis réessaie.";
export const GAMEPLAY_MARKER_CONTENTS = [
  "mode=anti-slow-v3",
  "patch=1046F98:8f>82,1046FE5:74>eb",
  `h1z1Sha256=${GAMEPLAY_CLIENT_BUILD.executableSha256.toUpperCase()}`,
  `proxySha256=${GAMEPLAY_PATCH_SHA256.toUpperCase()}`,
  "diagnostics=normal",
  "",
].join("\n");

export const GAMEPLAY_MARKER_SHA256 = createHash("sha256")
  .update(GAMEPLAY_MARKER_CONTENTS, "utf8")
  .digest("hex");

export type GameplayPatchMode = "patched" | "clean";
export type GameplayPatchInstallState = "patched" | "clean" | "unknown";

export interface GameplayPatchArtifact {
  sha256: string;
  bytes: number;
}

export interface GameplayPatchPolicy {
  active: GameplayPatchArtifact;
  retired: readonly GameplayPatchArtifact[];
  marker: {
    fileName: string;
    contents: string;
    sha256: string;
  };
  h1z1: GameplayPatchArtifact;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const DEFAULT_POLICY: GameplayPatchPolicy = {
  active: {
    sha256: GAMEPLAY_PATCH_SHA256,
    bytes: GAMEPLAY_PATCH_BYTES,
  },
  retired: RETIRED_GAMEPLAY_PATCHES,
  marker: {
    fileName: GAMEPLAY_MARKER_FILE_NAME,
    contents: GAMEPLAY_MARKER_CONTENTS,
    sha256: GAMEPLAY_MARKER_SHA256,
  },
  h1z1: {
    sha256: GAMEPLAY_CLIENT_BUILD.executableSha256,
    bytes: GAMEPLAY_CLIENT_BUILD.executableSize,
  },
};

export interface GameplayPatchState {
  schemaVersion: 1;
  mode: GameplayPatchMode;
  dllSha256: string | null;
  markerSha256: string | null;
  policyVersion: string | null;
  updatedAt: string;
}

type ManagedEntry =
  | { state: "absent" }
  | { state: "active" | "retired"; sha256: string; bytes: number };

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function readEntry(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameManagedEntry(left: ManagedEntry, right: ManagedEntry): boolean {
  if (left.state === "absent" || right.state === "absent") {
    return left.state === right.state;
  }
  return left.state === right.state
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

/**
 * Accept only the active ROTK artifact, a specifically retired ROTK artifact,
 * or absence. Links, directories and arbitrary DLLs must never be overwritten
 * or deleted by an automatic launcher migration.
 */
async function inspectManagedEntry(
  activePath: string,
  policy: GameplayPatchPolicy,
): Promise<ManagedEntry> {
  let entry;
  try {
    entry = await readEntry(activePath);
  } catch (error) {
    throw new Error(UNKNOWN_DINPUT_ERROR, { cause: error });
  }
  if (!entry) return { state: "absent" };
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(UNKNOWN_DINPUT_ERROR);
  }

  const candidate = [policy.active, ...policy.retired].find(
    (artifact) => artifact.bytes === entry.size,
  );
  if (!candidate) throw new Error(UNKNOWN_DINPUT_ERROR);

  let digest: string;
  try {
    digest = await sha256(activePath);
  } catch (error) {
    throw new Error(UNKNOWN_DINPUT_ERROR, { cause: error });
  }
  if (entry.size === policy.active.bytes && digest === policy.active.sha256) {
    return { state: "active", sha256: digest, bytes: entry.size };
  }
  if (policy.retired.some(
    (artifact) => artifact.bytes === entry.size && artifact.sha256 === digest,
  )) {
    return { state: "retired", sha256: digest, bytes: entry.size };
  }
  throw new Error(UNKNOWN_DINPUT_ERROR);
}

async function readMarker(
  root: string,
  policy: GameplayPatchPolicy,
): Promise<string | null> {
  const path = join(root, policy.marker.fileName);
  const entry = await readEntry(path);
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(MARKER_ERROR);
  }
  return readFile(path, "utf8").catch((error) => {
    throw new Error(MARKER_ERROR, { cause: error });
  });
}

async function writeMarker(
  root: string,
  policy: GameplayPatchPolicy,
): Promise<void> {
  const path = join(root, policy.marker.fileName);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, policy.marker.contents, { encoding: "utf8", mode: 0o600 });
    await retryFs(() => rename(temporaryPath, path));
  } catch (error) {
    throw new Error(MARKER_ERROR, { cause: error });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  const written = await readMarker(root, policy);
  if (written !== policy.marker.contents) throw new Error(MARKER_ERROR);
}

async function removeMarker(
  root: string,
  policy: GameplayPatchPolicy,
): Promise<void> {
  const path = join(root, policy.marker.fileName);
  const entry = await readEntry(path).catch((error) => {
    throw new Error(MARKER_ERROR, { cause: error });
  });
  if (!entry) return;
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(MARKER_ERROR);
  try {
    await retryFs(() => unlink(path));
  } catch (error) {
    throw new Error(MARKER_ERROR, { cause: error });
  }
  if (await readEntry(path)) throw new Error(MARKER_ERROR);
}

async function assertBundledPatch(
  bundledPatchPath: string,
  policy: GameplayPatchPolicy,
): Promise<void> {
  const entry = await stat(bundledPatchPath).catch(() => null);
  if (
    !entry?.isFile()
    || entry.size !== policy.active.bytes
    || await sha256(bundledPatchPath).catch(() => "") !== policy.active.sha256
  ) {
    throw new Error(INVALID_BUNDLED_PATCH_ERROR);
  }
}

async function assertSupportedH1Z1(
  root: string,
  policy: GameplayPatchPolicy,
): Promise<void> {
  const executablePath = join(root, "H1Z1.exe");
  const entry = await stat(executablePath).catch(() => null);
  if (
    !entry?.isFile()
    || entry.size !== policy.h1z1.bytes
    || await sha256(executablePath).catch(() => "") !== policy.h1z1.sha256
  ) {
    throw new Error(UNSUPPORTED_CLIENT_ERROR);
  }
}

async function deployGameplayPatchWithPolicy(
  root: string,
  bundledPatchPath: string,
  policy: GameplayPatchPolicy,
): Promise<"installed" | "replaced" | "up-to-date"> {
  // Validate release input before inspecting or mutating the player's client.
  await assertBundledPatch(bundledPatchPath, policy);
  await assertSupportedH1Z1(root, policy);

  const activePath = join(root, GAMEPLAY_PATCH_FILE_NAME);
  const initial = await inspectManagedEntry(activePath, policy);
  if (initial.state === "active") {
    if (await readMarker(root, policy) !== policy.marker.contents) {
      await writeMarker(root, policy);
    }
    return "up-to-date";
  }

  const temporaryPath = `${activePath}.rotk-${randomUUID()}.tmp`;
  try {
    await copyFile(bundledPatchPath, temporaryPath, fsConstants.COPYFILE_EXCL);
    const staged = await stat(temporaryPath).catch(() => null);
    if (
      !staged?.isFile()
      || staged.size !== policy.active.bytes
      || await sha256(temporaryPath).catch(() => "") !== policy.active.sha256
    ) {
      throw new Error(INSTALL_PATCH_ERROR);
    }

    // Detect a path replacement between validation and the atomic rename. This
    // cannot eliminate every hostile local race, but it closes ordinary drift
    // and ensures the launcher never knowingly replaces an unknown DLL.
    const current = await inspectManagedEntry(activePath, policy);
    if (!sameManagedEntry(initial, current)) {
      throw new Error(UNKNOWN_DINPUT_ERROR);
    }

    // The marker is written after the DLL so an interrupted upgrade leaves an
    // inert DLL rather than an old proxy that would ignore its own opt-in.
    try {
      await retryFs(() => rename(temporaryPath, activePath));
    } catch (error) {
      throw new Error(INSTALL_PATCH_ERROR, { cause: error });
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  const final = await inspectManagedEntry(activePath, policy).catch((error) => {
    throw new Error(INSTALL_PATCH_ERROR, { cause: error });
  });
  if (final.state !== "active") throw new Error(INSTALL_PATCH_ERROR);
  try {
    await writeMarker(root, policy);
  } catch (error) {
    // Fail closed: an unwritable marker must not leave a loaded-looking patch.
    await unlink(activePath).catch(() => undefined);
    throw error;
  }
  return initial.state === "absent" ? "installed" : "replaced";
}

async function depatchGameplayPatchWithPolicy(
  root: string,
  policy: GameplayPatchPolicy,
): Promise<"absent" | "removed"> {
  // Remove the opt-in marker first: even when the DLL cannot be deleted
  // (a game started outside the launcher keeps it mapped), the running proxy
  // restores both stock bytes and the next launch stays clean.
  await removeMarker(root, policy);

  const activePath = join(root, GAMEPLAY_PATCH_FILE_NAME);
  const initial = await inspectManagedEntry(activePath, policy);
  if (initial.state === "absent") return "absent";

  // Recheck immediately before deletion so ordinary concurrent drift cannot
  // turn a verified ROTK file into an unrelated file that we then remove.
  const current = await inspectManagedEntry(activePath, policy);
  if (!sameManagedEntry(initial, current)) throw new Error(UNKNOWN_DINPUT_ERROR);

  try {
    await retryFs(() => unlink(activePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error(REMOVE_PATCH_ERROR, { cause: error });
  }
  if (await readEntry(activePath)) throw new Error(REMOVE_PATCH_ERROR);
  return "removed";
}

async function gameplayPatchInstallStateWithPolicy(
  root: string,
  policy: GameplayPatchPolicy,
): Promise<GameplayPatchInstallState> {
  const entry = await inspectManagedEntry(join(root, GAMEPLAY_PATCH_FILE_NAME), policy)
    .catch(() => "unknown" as const);
  if (entry === "unknown") return "unknown";
  const marker = await readMarker(root, policy).catch(() => null);
  if (entry.state === "active" && marker === policy.marker.contents) return "patched";
  if (entry.state === "absent" && marker === null) return "clean";
  return "unknown";
}

async function assertGameplayPatchStateWithPolicy(
  root: string,
  mode: GameplayPatchMode,
  policy: GameplayPatchPolicy,
): Promise<void> {
  // Surface the precise unknown-DLL refusal instead of a generic install
  // failure: a third-party dinput8.dll must never be reported as our patch.
  const entry = await inspectManagedEntry(
    join(root, GAMEPLAY_PATCH_FILE_NAME),
    policy,
  );
  const marker = await readMarker(root, policy);
  if (mode === "patched") {
    if (entry.state !== "active" || marker !== policy.marker.contents) {
      throw new Error(INSTALL_PATCH_ERROR);
    }
    return;
  }
  if (entry.state !== "absent" || marker !== null) {
    throw new Error(REMOVE_PATCH_ERROR);
  }
}

/** Install or repair the exact two-byte shotgun sprint DirectInput proxy. */
export async function deployGameplayPatch(
  root: string,
  bundledPatchPath: string,
): Promise<"installed" | "replaced" | "up-to-date"> {
  return deployGameplayPatchWithPolicy(root, bundledPatchPath, DEFAULT_POLICY);
}

/**
 * Restore the launcher baseline for the mode the server directed. `clean`
 * removes the marker first and then the DLL; `patched` installs or repairs
 * both under the pinned hashes above.
 */
export async function applyGameplayPatchMode(
  root: string,
  bundledPatchPath: string,
  mode: GameplayPatchMode,
): Promise<"installed" | "replaced" | "up-to-date" | "absent" | "removed"> {
  return mode === "patched"
    ? deployGameplayPatchWithPolicy(root, bundledPatchPath, DEFAULT_POLICY)
    : depatchGameplayPatchWithPolicy(root, DEFAULT_POLICY);
}

/** Recheck the small installed proxy immediately before client preparation. */
export async function assertGameplayPatchState(
  root: string,
  mode: GameplayPatchMode,
): Promise<void> {
  return assertGameplayPatchStateWithPolicy(root, mode, DEFAULT_POLICY);
}

/** Classify the current installation without mutating it. */
export async function readGameplayPatchState(
  root: string,
): Promise<GameplayPatchInstallState> {
  return gameplayPatchInstallStateWithPolicy(root, DEFAULT_POLICY);
}

/**
 * Local AppData state lets a launcher that cannot reach the attestation
 * service reapply the last server decision instead of flipping the player's
 * client on its own. A missing state file means "no decision recorded yet".
 */
export async function readCachedGameplayPatchMode(
  userDataDirectory: string,
): Promise<GameplayPatchMode | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(userDataDirectory, STATE_FILE_NAME), "utf8"),
    ) as Partial<GameplayPatchState>;
    return parsed.mode === "patched" || parsed.mode === "clean" ? parsed.mode : null;
  } catch {
    return null;
  }
}

export async function recordGameplayPatchState(
  userDataDirectory: string,
  state: Omit<GameplayPatchState, "schemaVersion" | "updatedAt"> & { updatedAt?: string },
): Promise<void> {
  const path = join(userDataDirectory, STATE_FILE_NAME);
  const document: GameplayPatchState = {
    schemaVersion: 1,
    mode: state.mode,
    dllSha256: state.dllSha256,
    markerSha256: state.markerSha256,
    policyVersion: state.policyVersion,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await retryFs(() => rename(temporaryPath, path));
}

export const gameplayPatchInternals = {
  DEFAULT_POLICY,
  GAMEPLAY_MARKER_CONTENTS,
  STATE_FILE_NAME,
  assertBundledPatch,
  assertGameplayPatchStateWithPolicy,
  assertSupportedH1Z1,
  deployGameplayPatchWithPolicy,
  depatchGameplayPatchWithPolicy,
  gameplayPatchInstallStateWithPolicy,
  inspectManagedEntry,
  readMarker,
  removeMarker,
  sha256,
  sha256Text,
  writeMarker,
};
