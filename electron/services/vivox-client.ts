import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SUPPORTED_CLIENT_BUILDS } from "./client-build.js";
import { atomicCopyFile, atomicWriteFile } from "./fs-safe.js";

export const VIVOX_STOCK_V4_SHA256 =
  "d6915a466a905ae55f7e20019e01228c92cc86ce793a9fc050b49258a210c7b1";
export const VIVOX_STOCK_V5_SHA256 =
  "33a7f704eda23dda9ccbd9eba1fda2f0589211e9c61ec9d1f9c797acc624ea44";
export const VIVOX_PROXY_SHA256 =
  "d74662295af61d152a1869b2925d403ae984827bb55268cc20025d07ec9dabd5";
export const CROUCH_PARITY_MARKER_NAME = "rotk-crouch-parity.ini";

const CROUCH_CLIENT_BUILD_ID = "h1z1-1.0.326.439939";
const CROUCH_CLIENT_BUILD = SUPPORTED_CLIENT_BUILDS.find(
  (build) => build.id === CROUCH_CLIENT_BUILD_ID,
);
if (!CROUCH_CLIENT_BUILD) {
  throw new Error("The crouch patch has no matching supported H1Z1 build");
}

export const CROUCH_PARITY_MARKER_CONTENTS = [
  "mode=patch-v2",
  "animation=v12-opti1-hints512-nolog-ads-safe-pose-only-js-sine-idle400-200-move250",
  "cameraScalePitch=disabled",
  `h1z1Sha256=${CROUCH_CLIENT_BUILD.executableSha256.toUpperCase()}`,
  `proxySha256=${VIVOX_PROXY_SHA256.toUpperCase()}`,
  "",
].join("\n");

interface VivoxDeploymentPolicy {
  stockV4Sha256: string;
  stockV5Sha256: string;
  proxySha256: string;
  proxyMinBytes: number;
  proxyMaxBytes: number;
  h1z1Sha256: string;
  h1z1Bytes: number;
  crouchMarkerContents: string;
}

const DEFAULT_POLICY: VivoxDeploymentPolicy = {
  stockV4Sha256: VIVOX_STOCK_V4_SHA256,
  stockV5Sha256: VIVOX_STOCK_V5_SHA256,
  proxySha256: VIVOX_PROXY_SHA256,
  proxyMinBytes: 16_384,
  proxyMaxBytes: 2 * 1024 * 1024,
  h1z1Sha256: CROUCH_CLIENT_BUILD.executableSha256,
  h1z1Bytes: CROUCH_CLIENT_BUILD.executableSize,
  crouchMarkerContents: CROUCH_PARITY_MARKER_CONTENTS,
};

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

async function atomicCopy(source: string, destination: string): Promise<void> {
  await atomicCopyFile(source, destination);
}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  await atomicWriteFile(destination, contents, "ascii");
}

async function assertSupportedH1Z1(
  root: string,
  policy: VivoxDeploymentPolicy,
): Promise<void> {
  const executablePath = join(root, "H1Z1.exe");
  const executable = await stat(executablePath).catch(() => null);
  if (
    !executable?.isFile() ||
    executable.size !== policy.h1z1Bytes ||
    await fileHash(executablePath) !== policy.h1z1Sha256
  ) {
    throw new Error(
      "Cette version de H1Z1 n’est pas compatible avec le patch crouch ROTK obligatoire. Vérifie les fichiers du jeu dans Steam puis réessaie.",
    );
  }
}

async function assertBundledFiles(
  bundledProxyPath: string,
  bundledRuntimePath: string,
  policy: VivoxDeploymentPolicy,
): Promise<void> {
  const proxy = await stat(bundledProxyPath).catch(() => null);
  if (
    !proxy?.isFile() ||
    proxy.size < policy.proxyMinBytes ||
    proxy.size > policy.proxyMaxBytes ||
    await fileHash(bundledProxyPath) !== policy.proxySha256
  ) {
    throw new Error("Le proxy vocal ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.");
  }

  const runtime = await stat(bundledRuntimePath).catch(() => null);
  if (
    !runtime?.isFile() ||
    await fileHash(bundledRuntimePath) !== policy.stockV5Sha256
  ) {
    throw new Error("Le runtime Vivox 5 embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.");
  }
}

async function deployVivoxCompatibilityWithPolicy(
  root: string,
  bundledProxyPath: string,
  bundledRuntimePath: string,
  policy: VivoxDeploymentPolicy,
): Promise<void> {
  // Validate the executable and both bundled artifacts before modifying the
  // game installation. The native hook is intentionally tied to this exact
  // BR1315 image and must never run against an unknown executable.
  await assertBundledFiles(bundledProxyPath, bundledRuntimePath, policy);
  await assertSupportedH1Z1(root, policy);

  const activePath = join(root, "vivoxsdk_x64.dll");
  const backupPath = join(root, "vivoxsdk_x64.original.dll");
  const legacyBackupPath = join(root, "vivoxsdk_x64_original.dll");
  const v5Path = join(root, "vivoxsdk_x64_v5.dll");
  const crouchMarkerPath = join(root, CROUCH_PARITY_MARKER_NAME);

  const active = await stat(activePath).catch(() => null);
  if (!active?.isFile()) {
    throw new Error("Le SDK Vivox historique est introuvable.");
  }

  const activeHash = await fileHash(activePath);
  let backupHash = await fileHash(backupPath);

  if (backupHash !== policy.stockV4Sha256) {
    const legacyBackupHash = await fileHash(legacyBackupPath);
    if (legacyBackupHash === policy.stockV4Sha256) {
      await atomicCopy(legacyBackupPath, backupPath);
    } else if (activeHash === policy.stockV4Sha256) {
      await atomicCopy(activePath, backupPath);
    } else {
      throw new Error("La sauvegarde du SDK Vivox historique est invalide.");
    }
    backupHash = await fileHash(backupPath);
  }

  if (backupHash !== policy.stockV4Sha256) {
    throw new Error("La sauvegarde du SDK Vivox historique est invalide.");
  }

  // The legacy backup name does not match the attestation's `.original.dll`
  // backup shape, so leaving it would flag every migrated install as carrying
  // an unexpected DLL. Only our own verified backup is removed; an unknown
  // file under that name stays on disk and gets reported, as it should be.
  if (await fileHash(legacyBackupPath) === policy.stockV4Sha256) {
    await rm(legacyBackupPath, { force: true, maxRetries: 5, retryDelay: 100 });
  }

  // Repair an absent, stale, or corrupt Vivox 5 runtime from the validated copy.
  let runtimeHash = await fileHash(v5Path);
  if (runtimeHash !== policy.stockV5Sha256) {
    await atomicCopy(bundledRuntimePath, v5Path);
    runtimeHash = await fileHash(v5Path);
  }
  if (runtimeHash !== policy.stockV5Sha256) {
    throw new Error("La version Vivox 5 attendue est absente du client H1Z1.");
  }

  // Avoid rewriting the proxy on every launch, but always verify the final state.
  if (activeHash !== policy.proxySha256) {
    await atomicCopy(bundledProxyPath, activePath);
    if (await fileHash(activePath) !== policy.proxySha256) {
      throw new Error("Le proxy vocal ROTK n'a pas \u00e9t\u00e9 copi\u00e9 correctement.");
    }
  }

  // This marker is the native hook's explicit opt-in. There is no user-facing
  // toggle: install, adoption and every launch repair it before H1Z1 starts.
  if (
    await readFile(crouchMarkerPath, "ascii").catch(() => "") !==
    policy.crouchMarkerContents
  ) {
    await atomicWrite(crouchMarkerPath, policy.crouchMarkerContents);
  }
  if (
    await readFile(crouchMarkerPath, "ascii").catch(() => "") !==
    policy.crouchMarkerContents
  ) {
    throw new Error(
      "Le patch crouch ROTK obligatoire n'a pas \u00e9t\u00e9 activ\u00e9 correctement.",
    );
  }
}

/** Re-read installed bytes before spawn; never repair after attestation.
 * Bundle validation/migration belongs to the earlier deployment pass. No
 * persistent digest cache: a same-size edit between the passes must fail. */
async function assertVivoxCompatibilityWithPolicy(
  root: string,
  policy: VivoxDeploymentPolicy,
): Promise<void> {
  await assertSupportedH1Z1(root, policy);
  if (await fileHash(join(root, "vivoxsdk_x64.dll")) !== policy.proxySha256) {
    throw new Error("Le proxy vocal ROTK n'a pas \u00e9t\u00e9 copi\u00e9 correctement.");
  }
  if (await fileHash(join(root, "vivoxsdk_x64_v5.dll")) !== policy.stockV5Sha256) {
    throw new Error("La version Vivox 5 attendue est absente du client H1Z1.");
  }
  if (await fileHash(join(root, "vivoxsdk_x64.original.dll")) !== policy.stockV4Sha256) {
    throw new Error("La sauvegarde du SDK Vivox historique est invalide.");
  }
  if (await readFile(join(root, CROUCH_PARITY_MARKER_NAME), "ascii").catch(() => "") !== policy.crouchMarkerContents) {
    throw new Error("Le patch crouch ROTK obligatoire n'a pas \u00e9t\u00e9 activ\u00e9 correctement.");
  }
}

export async function assertVivoxCompatibility(root: string): Promise<void> {
  await assertVivoxCompatibilityWithPolicy(root, DEFAULT_POLICY);
}

/**
 * Installs ROTK's open-source compatibility layer and repairs the separately
 * provisioned official Vivox 5 runtime when either client DLL is not current.
 */
export async function deployVivoxCompatibility(
  root: string,
  bundledProxyPath: string,
  bundledRuntimePath: string,
): Promise<void> {
  await deployVivoxCompatibilityWithPolicy(
    root,
    bundledProxyPath,
    bundledRuntimePath,
    DEFAULT_POLICY,
  );
}

export const vivoxClientInternals = {
  deployVivoxCompatibilityWithPolicy,
  assertVivoxCompatibilityWithPolicy,
  sha256,
};
