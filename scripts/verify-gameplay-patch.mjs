import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const expectedHash =
  "73d6a0fca5ee4a0aac04be49b2440fd26545444bf912fc3e69a5287824c4f230";
const expectedBytes = 34_816;
const builtPath = resolve(
  process.argv[2] ?? "native/gameplaypatch/dist/dinput8.dll",
);
const bundledPath = resolve(
  process.argv[3] ?? "resources/patches/dinput8.dll",
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const built = await readFile(builtPath);
const bundled = await readFile(bundledPath);
const sidecar = await readFile(bundledPath + ".sha256", "ascii");
const sidecarMatch = sidecar.match(/^([0-9a-f]{64})\s+\*?dinput8\.dll\s*$/u);

if (built.byteLength !== expectedBytes || bundled.byteLength !== expectedBytes) {
  throw new Error(
    "Unexpected gameplay patch size: built=" + built.byteLength
      + ", bundled=" + bundled.byteLength,
  );
}
const builtHash = sha256(built);
const bundledHash = sha256(bundled);
if (
  builtHash !== expectedHash
  || bundledHash !== expectedHash
  || sidecarMatch?.[1] !== expectedHash
) {
  throw new Error(
    "Gameplay patch digest mismatch: expected=" + expectedHash
      + ", built=" + builtHash + ", bundled=" + bundledHash,
  );
}
if (!built.equals(bundled)) {
  throw new Error("Built and bundled gameplay patches are not byte-identical.");
}
if ((await stat(builtPath)).size !== (await stat(bundledPath)).size) {
  throw new Error("Built and bundled gameplay patches differ in size.");
}

const requiredBinarySequences = [
  Buffer.from([
    0x44, 0x8B, 0x87, 0x64, 0x3B, 0x00, 0x00, 0x45,
    0x85, 0xC0, 0x0F, 0x8F, 0x9E, 0x00, 0x00, 0x00,
    0x83, 0xBF, 0xA0, 0x09, 0x00, 0x00, 0x02,
  ]),
  Buffer.from([
    0xBA, 0x0A, 0x00, 0x00, 0x00, 0x48, 0x8B, 0xCF,
    0xE8, 0xE0, 0x79, 0xFF, 0xFE, 0x84, 0xC0, 0x74,
    0x19, 0x85, 0xF6, 0x74, 0x15, 0x48, 0x85, 0xDB,
  ]),
  Buffer.from("DirectInput8Create\0", "ascii"),
  Buffer.from("\\dinput8.dll\0", "utf16le"),
  Buffer.from("mode=anti-slow-v3\0", "ascii"),
  Buffer.from("patch=1046F98:8f>82,1046FE5:74>eb\0", "ascii"),
  Buffer.from("rotk-shotgun-sprint.ini\0", "utf16le"),
];
for (const sequence of requiredBinarySequences) {
  if (built.indexOf(sequence) < 0) {
    throw new Error(
      "Gameplay patch binary is missing contract sequence "
        + sequence.toString("hex") + ".",
    );
  }
}

for (const forbidden of [
  "AddVectoredExceptionHandler",
  "SetUnhandledExceptionFilter",
  "MiniDumpWriteDump",
]) {
  if (built.indexOf(Buffer.from(forbidden + "\0", "ascii")) >= 0) {
    throw new Error("Gameplay patch unexpectedly imports " + forbidden + ".");
  }
}

if (built.readUInt16LE(0) !== 0x5a4d) {
  throw new Error("Gameplay patch has no DOS header.");
}
const peOffset = built.readUInt32LE(0x3c);
if (
  peOffset + 24 > built.length
  || built.readUInt32LE(peOffset) !== 0x00004550
  || built.readUInt16LE(peOffset + 4) !== 0x8664
) {
  throw new Error("Gameplay patch is not a valid AMD64 PE image.");
}
const sectionCount = built.readUInt16LE(peOffset + 6);
const optionalHeaderBytes = built.readUInt16LE(peOffset + 20);
const optionalHeader = peOffset + 24;
if (
  optionalHeader + optionalHeaderBytes > built.length
  || built.readUInt16LE(optionalHeader) !== 0x20b
) {
  throw new Error("Gameplay patch has an invalid PE32+ optional header.");
}
const dllCharacteristics = built.readUInt16LE(optionalHeader + 0x46);
const requiredMitigations = 0x20 | 0x40 | 0x100;
if ((dllCharacteristics & requiredMitigations) !== requiredMitigations) {
  throw new Error(
    "Gameplay patch is missing ASLR/NX/HighEntropyVA: 0x"
      + dllCharacteristics.toString(16),
  );
}
const sectionTable = optionalHeader + optionalHeaderBytes;
for (let index = 0; index < sectionCount; index += 1) {
  const section = sectionTable + index * 40;
  if (section + 40 > built.length) {
    throw new Error("Gameplay patch section table is truncated.");
  }
  const characteristics = built.readUInt32LE(section + 36);
  if (
    (characteristics & 0x20000000) !== 0
    && (characteristics & 0x80000000) !== 0
  ) {
    throw new Error("Gameplay patch contains a writable executable section.");
  }
}

console.log(
  "Verified shotgun sprint gameplay patch: " + expectedHash + " ("
    + expectedBytes + " bytes, source rebuild matches bundle)",
);
