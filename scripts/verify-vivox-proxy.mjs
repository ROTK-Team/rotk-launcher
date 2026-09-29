import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Pinned release input, built from native/vivoxproxy since launcher 2.0.19 (fixed in 2.0.20)
// (npm run build:vivox:source, then copied here). CI rebuilds the sources twice
// and requires the same hash; a source build into dist/ never replaces it.
const expected = "8ab1f2379c61b81391492edb84875610ffbe4d3a8d97a180c73355d989ac27a2";
const proxyPath = resolve(process.argv[2] ?? "resources/patches/vivoxsdk_x64.dll");
const [binary, sidecar] = await Promise.all([
  readFile(proxyPath),
  readFile(`${proxyPath}.sha256`, "utf8"),
]);
assert.equal(binary.length, 73216, "Unexpected Vivox proxy size");
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
