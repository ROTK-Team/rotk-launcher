import { generateKeyPairSync, sign as signPayload, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_TEST_VECTORS,
  AttestationFormatError,
  challengeSigningInput,
  computeAttestationEvidence,
  computeManifestRoot,
  isAttestationExcluded,
  isManifestPath,
  isSha256Hex,
  manifestPathKey,
  manifestSigningInput,
  verifyAttestationSignature,
} from "../shared/attestation";

function ed25519KeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyRaw: spki.subarray(spki.length - 32).toString("base64url"), pkcs8 };
}

function sign(input: string, privateKey: KeyObject) {
  return signPayload(null, Buffer.from(input, "utf8"), privateKey).toString("base64url");
}

describe("canonical manifest root", () => {
  it("matches the frozen cross-implementation vector", () => {
    const { entries, expectedRoot } = ATTESTATION_TEST_VECTORS.manifestRoot;
    expect(computeManifestRoot(entries)).toBe(expectedRoot);
  });

  it("is independent of input order but ordered by lowercased path", () => {
    const { entries, expectedRoot } = ATTESTATION_TEST_VECTORS.manifestRoot;
    expect(computeManifestRoot([...entries].reverse())).toBe(expectedRoot);
    expect(manifestPathKey("Resources/Assets/A.pack2")).toBe("resources/assets/a.pack2");
  });

  it("changes when any file content, name or presence changes", () => {
    const base = [{ path: "a.pack2", size: 1, sha256: "a".repeat(64) }];
    expect(computeManifestRoot(base)).not.toBe(
      computeManifestRoot([{ path: "a.pack2", size: 1, sha256: "b".repeat(64) }]),
    );
    expect(computeManifestRoot(base)).not.toBe(
      computeManifestRoot([{ path: "b.pack2", size: 1, sha256: "a".repeat(64) }]),
    );
    expect(computeManifestRoot(base)).not.toBe(computeManifestRoot([]));
  });

  it("rejects duplicate, escaping and malformed entries", () => {
    const valid = { path: "H1Z1.exe", size: 1, sha256: "a".repeat(64) };
    expect(() => computeManifestRoot([valid, { ...valid, path: "h1z1.exe" }])).toThrow(AttestationFormatError);
    expect(() => computeManifestRoot([{ ...valid, path: "../escape" }])).toThrow(AttestationFormatError);
    expect(() => computeManifestRoot([{ ...valid, path: "/absolute" }])).toThrow(AttestationFormatError);
    expect(() => computeManifestRoot([{ ...valid, path: "back\\slash" }])).toThrow(AttestationFormatError);
    expect(() => computeManifestRoot([{ ...valid, sha256: "ABCDEF" }])).toThrow(AttestationFormatError);
    expect(() => computeManifestRoot([{ ...valid, size: -1 }])).toThrow(AttestationFormatError);
  });
});

describe("attestation evidence", () => {
  it("matches the frozen cross-implementation vector", () => {
    const { nonce, root, expectedEvidence } = ATTESTATION_TEST_VECTORS.evidence;
    expect(computeAttestationEvidence(nonce, root)).toBe(expectedEvidence);
  });

  it("binds the nonce, so a captured response cannot be replayed", () => {
    const { nonce, root } = ATTESTATION_TEST_VECTORS.evidence;
    expect(computeAttestationEvidence(nonce, root)).not.toBe(
      computeAttestationEvidence("YW5vdGhlci1ub25jZS0xMjM0NTY3", root),
    );
  });

  it("rejects malformed nonces and roots", () => {
    expect(() => computeAttestationEvidence("short", "a".repeat(64))).toThrow(AttestationFormatError);
    expect(() => computeAttestationEvidence("dGVzdC1ub25jZS0xMjM0NTY3ODkw", "nope")).toThrow(AttestationFormatError);
    expect(() => computeAttestationEvidence("has spaces and is long enough", "a".repeat(64)))
      .toThrow(AttestationFormatError);
  });
});

describe("signature verification", () => {
  it("accepts a signature from a trusted key and rejects everything else", () => {
    const { privateKey, publicKeyRaw } = ed25519KeyPair();
    const trusted = { "test-key-1": publicKeyRaw };
    const input = challengeSigningInput({
      challengeId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      nonce: ATTESTATION_TEST_VECTORS.evidence.nonce,
      policyVersion: "2026.08.01-1",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    const signature = sign(input, privateKey);

    expect(verifyAttestationSignature(input, signature, "test-key-1", trusted)).toBe(true);
    expect(verifyAttestationSignature(`${input}x`, signature, "test-key-1", trusted)).toBe(false);
    expect(verifyAttestationSignature(input, signature, "unknown-key", trusted)).toBe(false);
    expect(verifyAttestationSignature(input, signature, "test-key-1", { "test-key-1": ed25519KeyPair().publicKeyRaw }))
      .toBe(false);
  });

  it("fails closed on malformed inputs instead of throwing", () => {
    const trusted = { "test-key-1": ed25519KeyPair().publicKeyRaw };
    expect(verifyAttestationSignature("payload", "not base64url!", "test-key-1", trusted)).toBe(false);
    expect(verifyAttestationSignature("payload", "aGk", "test-key-1", trusted)).toBe(false);
    expect(verifyAttestationSignature("payload", null, "test-key-1", trusted)).toBe(false);
    expect(verifyAttestationSignature("payload", "a".repeat(86), null, trusted)).toBe(false);
    // A prototype-polluting keyId must not resolve to Object.prototype members.
    expect(verifyAttestationSignature("payload", "a".repeat(86), "toString", trusted)).toBe(false);
  });

  it("covers every identity-bearing manifest field", () => {
    const document = {
      kind: "base-game",
      schemaVersion: 1,
      version: "1.0.326.439939",
      root: "a".repeat(64),
      issuedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: null,
    };
    const base = manifestSigningInput(document);
    for (const field of ["kind", "version", "root", "issuedAt"] as const) {
      expect(manifestSigningInput({ ...document, [field]: "changed" })).not.toBe(base);
    }
    expect(manifestSigningInput({ ...document, expiresAt: "2026-09-01T00:00:00.000Z" })).not.toBe(base);
  });
});

/**
 * Canonical attestation contract, duplicated verbatim in the backend suite
 * (rotk-web/functions/attestationWiring.test.js). The two repositories are
 * checked out separately in CI, so each side asserts the same literals: a
 * divergence makes launcher and server disagree on what an unmodified
 * installation hashes to, which rejects every honest player.
 */
const CANONICAL = {
  excludedPaths: [
    ".rotk-installation.json",
    "battleye/beclient_x64.cfg",
    "battleye/beclient_x64.cfg.original",
    "clientconfig.ini",
    "clientconfig.original.ini",
    "inputprofile_user.xml",
    "launchpad.exe",
    "rotkc.dll",
    "steam_api64.original.dll",
    "steam_persona_name.txt",
    "useroptions.ini",
    "vivoxsdk_x64.original.dll",
  ],
  excludedPrefixes: ["battleye/", "cache/", "crashes/", "launchpad.libs/", "logs/"],
  excludedSuffixes: [".dmp", ".log", ".original"],
};

function extractStringSet(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const terminator = source.slice(start).search(/\]\)?;/);
  expect(terminator).toBeGreaterThan(0);
  return [...new Set(
    [...source.slice(start, start + terminator).matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  )].sort();
}

describe("canonical exclusion contract", () => {
  it("is identical in the shared module and the base manifest generator", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("..", import.meta.url));
    const moduleSource = await readFile(`${root}shared/attestation.ts`, "utf8");
    const generatorSource = await readFile(`${root}scripts/generate-base-manifest.mjs`, "utf8");

    for (const [source, prefix] of [[moduleSource, "ATTESTATION_"], [generatorSource, "const "]] as const) {
      expect(extractStringSet(source, `${prefix}EXCLUDED_PATHS`)).toEqual(CANONICAL.excludedPaths);
      expect(extractStringSet(source, `${prefix}EXCLUDED_PREFIXES`)).toEqual(CANONICAL.excludedPrefixes);
      expect(extractStringSet(source, `${prefix}EXCLUDED_SUFFIXES`)).toEqual(CANONICAL.excludedSuffixes);
    }
  });

  it("limits executable exemptions to the declared module, bootstrap and backups", () => {
    for (const path of CANONICAL.excludedPaths) {
      expect(path).not.toMatch(/\.pack2$/);
      if (path.endsWith(".exe")) expect(path).toBe("launchpad.exe");
      if (path.endsWith(".dll") && path !== "rotkc.dll") expect(path).toMatch(/\.original\.dll$/);
    }
    expect(CANONICAL.excludedPaths).not.toContain("steam_api64.dll");
    expect(isAttestationExcluded("LaunchPad.exe")).toBe(true);
    expect(isAttestationExcluded("LaunchPad.libs/libcef.dll")).toBe(true);
    expect(isAttestationExcluded("LaunchPad.bat")).toBe(false);
    expect(isAttestationExcluded("H1Z1.exe")).toBe(false);
    expect(isAttestationExcluded("Browser/Resources/libcef.dll")).toBe(false);
    expect(isAttestationExcluded("rotkc.dll")).toBe(true);
    expect(isAttestationExcluded("ROTKC.DLL")).toBe(true);
    for (const path of ["plugins/rotkc.dll", "rotkc.dll/", "rotkc.dll/other.dll", "rotkc.dll.bak.dll", "other.dll"]) {
      expect(isAttestationExcluded(path)).toBe(false);
    }
  });
});

describe("format guards", () => {
  it("validates digests and paths", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
    expect(isManifestPath("Resources/Assets/a.pack2")).toBe(true);
    expect(isManifestPath("")).toBe(false);
    expect(isManifestPath("../a")).toBe(false);
    expect(isManifestPath("a//b")).toBe(false);
    expect(isManifestPath("C:\\game\\a.pack2")).toBe(false);
  });
});
