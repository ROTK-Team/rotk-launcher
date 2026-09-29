import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateTpmAnchor,
  collectTpmAnchor,
  enrolTpmAnchor,
  parseTpmAnchorOutput,
  type TpmAnchorMaterial,
} from "../electron/services/tpm-anchor";

const PUB = Buffer.concat([Buffer.from("45434b31", "hex"), Buffer.from("20000000", "hex"), Buffer.alloc(64, 7)]).toString("base64");
const SIG = Buffer.alloc(64, 9).toString("base64");
const TPM_PUBLIC = Buffer.alloc(120, 1).toString("base64");
const EK = Buffer.alloc(283, 2).toString("base64");

const fullLine = JSON.stringify({
  publicKey: PUB, signature: SIG, tpmPublic: TPM_PUBLIC,
  ekPublicKey: EK, ekCertificates: ["QUJD", "REVG"], manufacturer: "STM ", version: "2.0", firmware: "0100020100000000",
});

describe("parseTpmAnchorOutput", () => {
  it("reads the proof, the TPM2B_PUBLIC and the endorsement material", () => {
    const material = parseTpmAnchorOutput(`﻿${fullLine}\r\n`);
    expect(material).not.toBeNull();
    expect(material!.proof).toEqual({ publicKey: PUB, signature: SIG, algo: "ecdsa-p256-sha256", tpmPublic: TPM_PUBLIC });
    expect(material!.ek).toEqual({
      publicKey: EK, certificates: ["QUJD", "REVG"], manufacturer: "STM", version: "2.0", firmware: "0100020100000000",
    });
  });

  it("keeps the proof when the provider exposed no EK, and drops malformed certificates", () => {
    const withoutEk = parseTpmAnchorOutput(JSON.stringify({ publicKey: PUB, signature: SIG, tpmPublic: TPM_PUBLIC }));
    expect(withoutEk?.ek).toBeNull();
    const oddCerts = parseTpmAnchorOutput(JSON.stringify({
      publicKey: PUB, signature: SIG, tpmPublic: TPM_PUBLIC, ekPublicKey: EK, ekCertificates: ["QUJD", 42, "not base64!", ""],
    }));
    expect(oddCerts?.ek?.certificates).toEqual(["QUJD"]);
    expect(oddCerts?.ek?.manufacturer).toBeNull();
  });

  it("refuses output without a proof", () => {
    expect(parseTpmAnchorOutput("")).toBeNull();
    expect(parseTpmAnchorOutput("not json")).toBeNull();
    expect(parseTpmAnchorOutput(JSON.stringify({ publicKey: PUB, signature: SIG }))).toBeNull();
    expect(parseTpmAnchorOutput(JSON.stringify({ publicKey: "*", signature: SIG, tpmPublic: TPM_PUBLIC }))).toBeNull();
  });
});

describe("collectTpmAnchor / activateTpmAnchor", () => {
  it("hands the message to the script through the environment, never the command line", async () => {
    if (process.platform !== "win32") return;
    let seen: Record<string, string> | null = null;
    const material = await collectTpmAnchor("rotk-tpm-bind-v1\0abc", {
      run: async (script, env) => { if (script.includes("rotk-tpm-aik-v1")) seen = env; return fullLine; },
    });
    // Base64: the binding message's NUL separators cannot travel in an environment variable.
    expect(seen).toEqual({ ROTK_TPM_MESSAGE_B64: Buffer.from("rotk-tpm-bind-v1\0abc", "utf8").toString("base64") });
    expect(material?.proof.publicKey).toBe(PUB);
    expect(await collectTpmAnchor("", { run: async () => fullLine })).toBeNull();
    expect(await collectTpmAnchor("x", { run: async () => { throw new Error("no tpm"); } })).toBeNull();
  });

  it("concatenates the two TPM2B blobs for the PCP and returns the secret it prints", async () => {
    if (process.platform !== "win32") return;
    const credential = Buffer.from("0002abcd", "hex").toString("base64");
    const secret = Buffer.from("00020102", "hex").toString("base64");
    let seen: Record<string, string> | null = null;
    const recovered = await activateTpmAnchor(credential, secret, {
      run: async (_script, env) => { seen = env; return "c2VjcmV0\r\n"; },
    });
    expect(seen).toEqual({ ROTK_TPM_ACTIVATION: Buffer.from("0002abcd00020102", "hex").toString("base64") });
    expect(recovered).toBe("c2VjcmV0");
    expect(await activateTpmAnchor("not base64!", secret, { run: async () => "x" })).toBeNull();
    expect(await activateTpmAnchor(credential, secret, { run: async () => { throw new Error("blocked"); } })).toBeNull();
  });
});

describe("enrolTpmAnchor", () => {
  const material: TpmAnchorMaterial = {
    proof: { publicKey: PUB, signature: SIG, algo: "ecdsa-p256-sha256", tpmPublic: TPM_PUBLIC },
    ek: { publicKey: EK, certificates: [], manufacturer: "STM", version: "2.0", firmware: null },
  };
  const endpoints = { beginUrl: "https://rotk.app/api/launcher/tpm/enroll-begin", completeUrl: "https://rotk.app/api/launcher/tpm/enroll-complete" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("activates the credential the server hands back and completes with the recovered secret", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      if (calls.length === 1) return json({ state: "activate", activationId: "id-1", credentialBlob: "AAAA", encryptedSecret: "BBBB" });
      return json({ state: "activated" });
    }) as unknown as typeof fetch;
    const outcome = await enrolTpmAnchor(endpoints, "0123456789abcdef0123456789abcdef", "2.0.12", material, {
      fetchImpl,
      run: async () => Buffer.from(createHash("sha256").update("secret").digest()).toString("base64"),
    });
    expect(outcome).toEqual({ state: "activated" });
    expect(calls.map((call) => call.url)).toEqual([endpoints.beginUrl, endpoints.completeUrl]);
    expect(calls[0]!.body["anchor"]).toEqual({ publicKey: PUB, tpmPublic: TPM_PUBLIC, ek: material.ek });
    expect(calls[0]!.body["launcherVersion"]).toBe("2.0.12");
    expect(calls[1]!.body["activationId"]).toBe("id-1");
    expect(typeof calls[1]!.body["secret"]).toBe("string");
  });

  it("is one request once the key is activated, and never throws on refusals", async () => {
    let count = 0;
    const activated = (async () => { count += 1; return json({ state: "activated" }); }) as unknown as typeof fetch;
    expect(await enrolTpmAnchor(endpoints, "k", "2.0.12", material, { fetchImpl: activated })).toEqual({ state: "activated" });
    expect(count).toBe(1);
    const refused = (async () => json({ error: "permission-denied" }, 403)) as unknown as typeof fetch;
    expect((await enrolTpmAnchor(endpoints, "k", "2.0.12", material, { fetchImpl: refused })).state).toBe("failed");
    const unreachable = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await enrolTpmAnchor(endpoints, "k", "2.0.12", material, { fetchImpl: unreachable })).state).toBe("failed");
  });

  it("does not enrol without an endorsement key, and reports a TPM that will not activate", async () => {
    expect(await enrolTpmAnchor(endpoints, "k", "2.0.12", { ...material, ek: null }, {
      fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
    })).toEqual({ state: "skipped", reason: "no-endorsement-key" });
    if (process.platform !== "win32") return;
    const challenge = (async () => json({ state: "activate", activationId: "id-2", credentialBlob: "AAAA", encryptedSecret: "BBBB" })) as unknown as typeof fetch;
    const outcome = await enrolTpmAnchor(endpoints, "k", "2.0.12", material, {
      fetchImpl: challenge, run: async () => { throw new Error("The command was blocked."); },
    });
    expect(outcome).toEqual({ state: "failed", reason: "the TPM did not activate the credential" });
  });
});

describe("TPM endorsement cache", () => {
  it("reads the endorsement key once per machine", async () => {
    if (process.platform !== "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "vitest-tpm-"));
    try {
      const cachePath = join(directory, "tpm-endorsement.v1.json");
      const scripts: string[] = [];
      const run = async (script: string) => { scripts.push(script); return fullLine; };
      await collectTpmAnchor("one", { run, endorsementCachePath: cachePath });
      await collectTpmAnchor("two", { run, endorsementCachePath: cachePath });
      expect(scripts.filter((script) => script.includes("Add-Type"))).toHaveLength(1);
      expect(scripts).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("collectTpmAnchor (real TPM, win32 only)", () => {
  it("signs with a TPM identity key whose TPM2B_PUBLIC names the same point as the Windows blob", async () => {
    if (process.platform !== "win32") return;
    const material = await collectTpmAnchor("rotk-anchor-probe");
    if (material === null) return; // no usable TPM here; the feature is a no-op
    const blob = Buffer.from(material.proof.publicKey, "base64");
    expect(blob.readUInt32LE(4)).toBe(32);
    const tpmPublic = Buffer.from(material.proof.tpmPublic, "base64");
    // TPM2B_PUBLIC: size, then TPMT_PUBLIC whose unique field ends with X and Y.
    expect(tpmPublic.readUInt16BE(0)).toBe(tpmPublic.length - 2);
    expect(tpmPublic.readUInt16BE(2)).toBe(0x0023); // TPM_ALG_ECC
    const x = blob.subarray(8, 40);
    const y = blob.subarray(40, 72);
    expect(tpmPublic.subarray(tpmPublic.length - 32).equals(y)).toBe(true);
    expect(tpmPublic.subarray(tpmPublic.length - 66, tpmPublic.length - 34).equals(x)).toBe(true);
    // The EK public part is readable without elevation; the certificate may not be.
    expect(material.ek === null || Buffer.from(material.ek.publicKey, "base64").readUInt32LE(0) === 0x31415352).toBe(true);
  }, 30_000); // a runner without a TPM spends seconds in Add-Type and the PCP before answering
});
