#!/usr/bin/env node
/**
 * Builds the signed BASE_MANIFEST for a pristine H1Z1 installation.
 *
 * The manifest enumerates every file of the untouched game tree with its
 * sha256, and carries the canonical root the server stores as `expectedRoot`.
 * Run it once per supported client build, from a Steam-verified installation
 * that the launcher has never patched.
 *
 * Excluded by design (the launcher rewrites these on every launch, so they can
 * never be part of a stable root): see EXCLUDED_PATHS below.
 *
 * Usage:
 *   node scripts/generate-base-manifest.mjs \
 *     --source "D:/Steam/steamapps/common/H1Z1" \
 *     --build-id 1.0.326.439939 \
 *     --out out/base-manifest.v1.json \
 *     [--sign-seed <base64url> --key-id rotk-attest-2026-08]
 *
 * Without --sign-seed the manifest is written unsigned (for inspection); the
 * release pipeline signs it with the Secret Manager seed.
 */

import { createHash, sign as signPayload } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const MANIFEST_ROOT_DOMAIN = "rotk-manifest-v1";
const MANIFEST_SIGNATURE_DOMAIN = "rotk-manifest-sig-v1";
const SCHEMA_VERSION = 1;

/**
 * MIRROR of ATTESTATION_EXCLUDED_* in shared/attestation.ts (a standalone
 * script cannot import the TS module). Keep them identical — a divergence
 * makes the launcher and the server disagree on the expected root and rejects
 * every honest player. Inclusion criteria and rationale live in that module.
 */
const EXCLUDED_PATHS = new Set([
  // Per-player, rewritten by the game itself.
  "useroptions.ini",
  "inputprofile_user.xml",
  // Daybreak updates this unused bootstrap independently. ROTK starts
  // H1Z1.exe directly; the game executable remains attested.
  "launchpad.exe",
  // Independently updated client module: exact root path, any hash, optional.
  "rotkc.dll",
  // Rewritten by the launcher before every launch.
  "clientconfig.ini",
  "battleye/beclient_x64.cfg",
  "steam_persona_name.txt",
  // Launcher bookkeeping and vanilla backups.
  ".rotk-installation.json",
  "clientconfig.original.ini",
  "battleye/beclient_x64.cfg.original",
  "steam_api64.original.dll",
  "vivoxsdk_x64.original.dll",
]);
const EXCLUDED_PREFIXES = ["logs/", "crashes/", "cache/", "battleye/", "launchpad.libs/"];
const EXCLUDED_SUFFIXES = [".log", ".dmp", ".original"];

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) continue;
    args.set(argv[index].slice(2), argv[index + 1] ?? "");
  }
  return args;
}

function isExcluded(relativePath) {
  const lower = relativePath.toLowerCase();
  if (EXCLUDED_PATHS.has(lower)) return true;
  if (EXCLUDED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

async function* walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, absolute);
    } else if (entry.isFile()) {
      yield absolute;
    }
    // Symlinks and specials are skipped: a pristine Steam tree has none, and
    // following them could hash files outside the installation.
  }
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function computeManifestRoot(entries) {
  const hash = createHash("sha256");
  hash.update(`${MANIFEST_ROOT_DOMAIN}\0`, "utf8");
  const sorted = [...entries].sort((left, right) => {
    const leftKey = left.path.toLowerCase();
    const rightKey = right.path.toLowerCase();
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  for (const entry of sorted) {
    hash.update(`${entry.path}\0${entry.sha256}\n`, "utf8");
  }
  return hash.digest("hex");
}

function ed25519PrivateKeyDer(seedBase64Url) {
  const raw = Buffer.from(seedBase64Url, "base64url");
  if (raw.length !== 32) throw new Error("The signing seed must decode to 32 bytes.");
  return Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.get("source");
  const buildId = args.get("build-id");
  const outPath = args.get("out") ?? "out/base-manifest.v1.json";
  const signSeed = args.get("sign-seed") ?? "";
  const keyId = args.get("key-id") ?? "";

  if (!source || !buildId) {
    console.error("Usage: node scripts/generate-base-manifest.mjs --source <game dir> --build-id <id> [--out <file>] [--sign-seed <seed> --key-id <id>]");
    process.exit(2);
  }
  if (Boolean(signSeed) !== Boolean(keyId)) {
    console.error("--sign-seed and --key-id must be provided together.");
    process.exit(2);
  }

  const root = resolve(source);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(2);
  }

  const files = [];
  let totalBytes = 0;
  let excludedCount = 0;
  for await (const absolute of walk(root)) {
    const relativePath = relative(root, absolute).split(sep).join("/");
    if (isExcluded(relativePath)) {
      excludedCount += 1;
      continue;
    }
    const fileStat = await stat(absolute);
    const sha256 = await sha256File(absolute);
    files.push({ path: relativePath, size: fileStat.size, sha256 });
    totalBytes += fileStat.size;
    if (files.length % 500 === 0) process.stderr.write(`  hashed ${files.length} files\r`);
  }

  const seen = new Set();
  for (const entry of files) {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate path after normalization: ${entry.path}`);
    seen.add(key);
  }

  const manifestRoot = computeManifestRoot(files);
  const issuedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "base-game",
    buildId,
    root: manifestRoot,
    fileCount: files.length,
    totalBytes,
    issuedAt,
    files,
    ...(keyId ? { keyId } : {}),
  };

  if (signSeed) {
    const signingInput = [
      MANIFEST_SIGNATURE_DOMAIN,
      "base-game",
      String(SCHEMA_VERSION),
      buildId,
      manifestRoot,
      issuedAt,
      "",
    ].join("\0");
    manifest.signature = signPayload(
      null,
      Buffer.from(signingInput, "utf8"),
      { key: ed25519PrivateKeyDer(signSeed), format: "der", type: "pkcs8" },
    ).toString("base64url");
  }

  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(resolve(outPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`build      : ${buildId}`);
  console.log(`files      : ${files.length} (${excludedCount} excluded)`);
  console.log(`total      : ${(totalBytes / 1024 ** 3).toFixed(2)} GB`);
  console.log(`root       : ${manifestRoot}`);
  console.log(`signature  : ${manifest.signature ? `present (${keyId})` : "ABSENT — unsigned manifest"}`);
  console.log(`written    : ${resolve(outPath)}`);
  console.log("");
  console.log("Store this root as expectedRoot when publishing the attestation policy.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
