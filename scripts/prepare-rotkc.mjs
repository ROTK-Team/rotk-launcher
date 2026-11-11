// The supplied rotkc.dll is larger than GitHub's 100 MB limit per file, so the
// repository keeps it Brotli-compressed. This restores the exact supplied file
// beside the other bundled patches and refuses any other content.
//
//   node scripts/prepare-rotkc.mjs                      restore and verify
//   node scripts/prepare-rotkc.mjs --pack <rotkc.dll>   store a newly supplied build
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const patches = new URL("../resources/patches/", import.meta.url);
const dllPath = new URL("rotkc.dll", patches);
const packedPath = new URL("rotkc.dll.br", patches);
const sidecarPath = new URL("rotkc.dll.sha256", patches);
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const packing = process.argv[2] === "--pack";
if (process.argv.length !== (packing ? 4 : 2)) {
  throw new Error("Usage: node scripts/prepare-rotkc.mjs [--pack <rotkc.dll>]");
}

if (packing) {
  const source = readFileSync(process.argv[3]);
  // Fixed parameters: the same input always gives the same compressed file.
  const packed = brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });
  if (packed.length >= GITHUB_FILE_LIMIT) {
    throw new Error(`rotkc.dll.br would be ${packed.length} bytes: GitHub refuses files of 100 MiB or more.`);
  }
  writeFileSync(packedPath, packed);
  writeFileSync(sidecarPath, `${sha256(source)} *rotkc.dll\n`, "ascii");
  console.log(`rotkc.dll.br written: ${packed.length} bytes`);
}

// The sidecar holds the SHA-256 of the restored file, not of the compressed one.
const expected = readFileSync(sidecarPath, "ascii").trim().split(/\s+/)[0].toLowerCase();
if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("rotkc.dll.sha256 does not hold a SHA-256.");

const present = existsSync(dllPath) ? sha256(readFileSync(dllPath)) : null;
// After --pack, restore even when the file is already there: it proves the round trip.
if (packing || present !== expected) {
  const dll = brotliDecompressSync(readFileSync(packedPath));
  const actual = sha256(dll);
  if (actual !== expected) {
    throw new Error(`rotkc.dll.br does not restore the supplied rotkc.dll: SHA-256 ${actual}, expected ${expected}.`);
  }
  if (present !== expected) {
    if (present && !packing) {
      console.warn(`Replacing a different rotkc.dll (SHA-256 ${present}). Use --pack to store a newly supplied build.`);
    }
    writeFileSync(dllPath, dll);
  }
}
console.log(`rotkc.dll ready: ${statSync(dllPath).size} bytes, SHA-256 ${expected}`);
