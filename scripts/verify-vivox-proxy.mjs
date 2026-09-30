import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Supplied release input, pinned byte for byte (see VIVOX_RELEASE_20260930.md).
// Reference source builds remain independent and never replace this file.
const expected = "5350449196dea51278b9c70da36ac621d4bda626bcded8c1bb3a83b07ec62c32";
const proxyPath = resolve(process.argv[2] ?? "resources/patches/vivoxsdk_x64.dll");
const [binary, sidecar] = await Promise.all([
  readFile(proxyPath),
  readFile(`${proxyPath}.sha256`, "utf8"),
]);
assert.equal(binary.length, 80384, "Unexpected Vivox proxy size");
assert.equal(createHash("sha256").update(binary).digest("hex"), expected,
  "The supplied Vivox release proxy has changed");
assert.equal(sidecar.trim().split(/\s+/u)[0], expected,
  "Vivox attestation sidecar differs from the released binary");
const pe = binary.readUInt32LE(0x3c);
assert.equal(binary.readUInt16LE(0), 0x5a4d, "Missing DOS header");
assert.equal(binary.readUInt32LE(pe), 0x4550, "Missing PE signature");
assert.equal(binary.readUInt16LE(pe + 4), 0x8664, "Vivox must be AMD64");
assert.equal(binary.readUInt16LE(pe + 24), 0x20b, "Vivox must be PE32+");
assert(binary.readUInt16LE(pe + 22) & 0x2000, "Vivox must be a DLL");
console.log(`Verified supplied Vivox release proxy: ${proxyPath} (${expected})`);
