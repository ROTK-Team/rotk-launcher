// The supplied rotkc.dll is larger than GitHub's 100 MB limit per file, so the
// repository keeps it Brotli-compressed. This restores the exact supplied file
// beside the other bundled patches and refuses any other content.
//
//   node scripts/prepare-rotkc.mjs                      restore and verify
//   node scripts/prepare-rotkc.mjs --pack <rotkc.dll>   store a newly supplied build
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const patches = new URL("../resources/patches/", import.meta.url);
const dllPath = new URL("rotkc.dll", patches);
const packedPath = new URL("rotkc.dll.br", patches);
const sidecarPath = new URL("rotkc.dll.sha256", patches);
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (process.argv[2] === "--pack") {
  if (!process.argv[3]) throw new Error("Usage: node scripts/prepare-rotkc.mjs --pack <rotkc.dll>");
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
    throw new Error(`rotkc.dll.br would be ${packed.length} bytes: GitHub refuses files of 100 MB or more.`);
  }
  writeFileSync(packedPath, packed);
  writeFileSync(sidecarPath, `${sha256(source)} *rotkc.dll\n`, "ascii");
  console.log(`rotkc.dll.br written: ${packed.length} bytes`);
}

// The sidecar holds the SHA-256 of the restored file, not of the compressed one.
const expected = readFileSync(sidecarPath, "ascii").trim().split(/\s+/)[0].toLowerCase();
if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("rotkc.dll.sha256 does not hold a SHA-256.");

if (!existsSync(dllPath) || sha256(readFileSync(dllPath)) !== expected) {
  const dll = brotliDecompressSync(readFileSync(packedPath));
  const actual = sha256(dll);
  if (actual !== expected) {
    throw new Error(`rotkc.dll.br does not restore the supplied rotkc.dll: SHA-256 ${actual}, expected ${expected}.`);
  }
  writeFileSync(dllPath, dll);
}
const restored = readFileSync(dllPath);
if (sha256(restored) !== expected) throw new Error("The restored rotkc.dll does not match rotkc.dll.sha256.");
console.log(`rotkc.dll ready: ${restored.length} bytes, SHA-256 ${expected}`);
