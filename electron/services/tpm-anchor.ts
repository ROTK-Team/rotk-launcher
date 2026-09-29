/**
 * TPM anchor (Windows, level 2 — issue #320 §A): the endorsement key.
 *
 * Level 1 (tpm-identity.ts) signs with a persisted TPM key, but nothing tells
 * the server the key is in a TPM rather than in a rebuilt launcher's software.
 * This module adds the piece that does: a second key the TPM creates as an
 * *identity* key (the Platform Crypto Provider's attestation-key policy), sent
 * together with the TPM's own description of it (TPM2B_PUBLIC) and the
 * endorsement key's public part. The server encrypts a secret to the EK for
 * that key's TPM name (TPM2_MakeCredential); only this TPM can recover it
 * (TPM2_ActivateCredential, run here through the PCP), and from then on the
 * key's signature over the binding message says "this TPM".
 *
 * Elevation: the EK public part and the activation are available to any user
 * through the PCP; reading the EK *certificate* (what proves the TPM is a real
 * one) and running the activation command are refused by Windows to a
 * standard user (TBS blocks the command). The launcher runs as the invoking
 * user since 2.0.15, so those pieces are usually absent and the server
 * records that.
 *
 * Best-effort everywhere: no TPM, no provider, a blocked command or a refused
 * read yield null and the launch proceeds. The launcher never self-exempts;
 * the server decides what an absent anchor means.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { windowsSystemToolPath } from "./windows-tools.js";

const execFileAsync = promisify(execFile);

/** The persisted identity key in the platform provider; stable across launches. */
const KEY_NAME = "rotk-tpm-aik-v1";

const NCRYPT_INTEROP = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class RotkNCrypt {
  [DllImport("ncrypt.dll")] public static extern int NCryptOpenStorageProvider(out IntPtr phProvider, [MarshalAs(UnmanagedType.LPWStr)] string pszProviderName, uint dwFlags);
  [DllImport("ncrypt.dll")] public static extern int NCryptGetProperty(IntPtr hObject, [MarshalAs(UnmanagedType.LPWStr)] string pszProperty, byte[] pbOutput, uint cbOutput, out uint pcbResult, uint dwFlags);
  [DllImport("ncrypt.dll")] public static extern int NCryptFreeObject(IntPtr hObject);
  public static byte[] Get(IntPtr h, string name) {
    uint cb; if (NCryptGetProperty(h, name, null, 0, out cb, 0) != 0) return null;
    var buf = new byte[cb]; if (NCryptGetProperty(h, name, buf, cb, out cb, 0) != 0) return null;
    Array.Resize(ref buf, (int)cb); return buf; }
}
"@
`;

/**
 * Opens (or creates, once) the identity key, signs the message passed
 * base64-encoded in ROTK_TPM_MESSAGE_B64 (the binding message carries NUL
 * separators, which a child's environment cannot), exports the Windows public
 * blob and the TPM2B_PUBLIC the PCP key blob carries, and prints one JSON
 * line. Plain .NET Framework 4.x, so it runs under the stock Windows
 * PowerShell 5.1 without compiling anything.
 */
const COLLECT_SCRIPT = `
$ErrorActionPreference = "Stop"
$encoded = $env:ROTK_TPM_MESSAGE_B64
if ([string]::IsNullOrEmpty($encoded)) { throw "no message" }
$data = [Convert]::FromBase64String($encoded)
$provider = [System.Security.Cryptography.CngProvider]::new("Microsoft Platform Crypto Provider")
if ([System.Security.Cryptography.CngKey]::Exists("${KEY_NAME}", $provider)) {
  $key = [System.Security.Cryptography.CngKey]::Open("${KEY_NAME}", $provider)
} else {
  $p = [System.Security.Cryptography.CngKeyCreationParameters]::new()
  $p.Provider = $provider
  $p.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
  $p.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
  $p.Parameters.Add([System.Security.Cryptography.CngProperty]::new("PCP_KEY_USAGE_POLICY", [BitConverter]::GetBytes([uint32]1), [System.Security.Cryptography.CngPropertyOptions]::None))
  $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, "${KEY_NAME}", $p)
}
$ecdsa = [System.Security.Cryptography.ECDsaCng]::new($key)
$sig = $ecdsa.SignData($data, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
$pub = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
$opaque = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::new("OpaqueKeyBlob"))
$header = [BitConverter]::ToUInt32($opaque, 4)
$cbPublic = [BitConverter]::ToUInt32($opaque, 16)
$tpmPublic = New-Object byte[] $cbPublic
[Array]::Copy($opaque, $header, $tpmPublic, 0, $cbPublic)
$r = @{
  publicKey = [Convert]::ToBase64String($pub)
  signature = [Convert]::ToBase64String($sig)
  tpmPublic = [Convert]::ToBase64String($tpmPublic)
}
Write-Output ($r | ConvertTo-Json -Compress)
`;

/**
 * Reads the endorsement key's public part and what it can of its certificate
 * chain. The only step that needs Add-Type (it compiles C# with csc.exe, which
 * antivirus heuristics dislike), and its answer never changes on a machine:
 * it runs once and the result is cached.
 */
const ENDORSEMENT_SCRIPT = `
$ErrorActionPreference = "Stop"
${NCRYPT_INTEROP}
$r = @{}
$h = [IntPtr]::Zero
if ([RotkNCrypt]::NCryptOpenStorageProvider([ref]$h, "Microsoft Platform Crypto Provider", 0) -eq 0) {
  try {
    $ekpub = [RotkNCrypt]::Get($h, "PCP_EKPUB")
    if ($ekpub -ne $null) { $r.ekPublicKey = [Convert]::ToBase64String($ekpub) }
    $man = [RotkNCrypt]::Get($h, "PCP_TPM_MANUFACTURER_ID")
    if ($man -ne $null) { $r.manufacturer = [Text.Encoding]::Unicode.GetString($man).Trim([char]0).Trim() }
    $ver = [RotkNCrypt]::Get($h, "PCP_TPM_VERSION")
    if ($ver -ne $null -and $ver.Length -ge 4) { $v = [BitConverter]::ToUInt32($ver, 0); $r.version = "$($v -shr 16).$($v -band 0xffff)" }
    $fw = [RotkNCrypt]::Get($h, "PCP_TPM_FW_VERSION")
    if ($fw -ne $null) { $r.firmware = (($fw | ForEach-Object { $_.ToString("x2") }) -join "") }
    $certs = @()
    $cert = [RotkNCrypt]::Get($h, "PCP_EKCERT")
    if ($cert -ne $null -and $cert.Length -gt 0) { $certs += [Convert]::ToBase64String($cert) }
    if ($certs.Count -eq 0) {
      try {
        $info = Get-TpmEndorsementKeyInfo -HashAlgorithm Sha256
        foreach ($c in @($info.ManufacturerCertificates) + @($info.AdditionalCertificates)) {
          if ($c -ne $null -and $c.RawData -ne $null) { $certs += [Convert]::ToBase64String($c.RawData) }
        }
      } catch {}
    }
    $r.ekCertificates = $certs
  } finally { [void][RotkNCrypt]::NCryptFreeObject($h) }
}
Write-Output ($r | ConvertTo-Json -Compress)
`;

/**
 * Hands the server's credential (TPM2B_ID_OBJECT || TPM2B_ENCRYPTED_SECRET,
 * base64 in ROTK_TPM_ACTIVATION) to the identity key: the PCP runs
 * TPM2_ActivateCredential against the endorsement key and the recovered
 * secret is read back. Blocked by Windows for a standard user.
 */
const ACTIVATE_SCRIPT = `
$ErrorActionPreference = "Stop"
$blob = [Convert]::FromBase64String($env:ROTK_TPM_ACTIVATION)
$provider = [System.Security.Cryptography.CngProvider]::new("Microsoft Platform Crypto Provider")
$key = [System.Security.Cryptography.CngKey]::Open("${KEY_NAME}", $provider)
$key.SetProperty([System.Security.Cryptography.CngProperty]::new("PCP_TPM12_IDACTIVATION", $blob, [System.Security.Cryptography.CngPropertyOptions]::None))
$secret = $key.GetProperty("PCP_TPM12_IDACTIVATION", [System.Security.Cryptography.CngPropertyOptions]::None).GetValue()
Write-Output ([Convert]::ToBase64String($secret))
`;

/** The anchor as the ticket carries it: the identity key's proof over the binding message, plus its TPM2B_PUBLIC. */
export interface TpmAnchorProof {
  readonly publicKey: string;
  readonly signature: string;
  readonly algo: "ecdsa-p256-sha256";
  readonly tpmPublic: string;
}

/** What the enrolment sends about the endorsement key. */
export interface TpmEndorsement {
  /** BCRYPT_RSAKEY_BLOB of the EK public part, base64. */
  readonly publicKey: string;
  /** The EK certificate chain, DER base64, leaf first; empty when not readable (not elevated). */
  readonly certificates: readonly string[];
  readonly manufacturer: string | null;
  readonly version: string | null;
  readonly firmware: string | null;
}

export interface TpmAnchorMaterial {
  readonly proof: TpmAnchorProof;
  /** Null when the provider exposed no EK: the proof is still sent, the enrolment is not attempted. */
  readonly ek: TpmEndorsement | null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const b64 = (value: unknown, max: number): string | null =>
  typeof value === "string" && value !== "" && value.length <= max && BASE64.test(value) ? value : null;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;

/** Parse the JSON line the collect script prints. Exported for tests. */
export function parseTpmAnchorOutput(stdout: string): TpmAnchorMaterial | null {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("{"));
  if (line === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const publicKey = b64(record["publicKey"], 4096);
  const signature = b64(record["signature"], 4096);
  const tpmPublic = b64(record["tpmPublic"], 1024);
  if (publicKey === null || signature === null || tpmPublic === null) return null;
  const proof: TpmAnchorProof = { publicKey, signature, algo: "ecdsa-p256-sha256", tpmPublic };
  const ekPublicKey = b64(record["ekPublicKey"], 2048);
  if (ekPublicKey === null) return { proof, ek: null };
  const rawCertificates = Array.isArray(record["ekCertificates"]) ? record["ekCertificates"] : [];
  const certificates = rawCertificates.map((c) => b64(c, 8192)).filter((c): c is string => c !== null).slice(0, 4);
  return {
    proof,
    ek: {
      publicKey: ekPublicKey,
      certificates,
      manufacturer: text(record["manufacturer"], 16),
      version: text(record["version"], 32),
      firmware: text(record["firmware"], 32),
    },
  };
}

async function runPowerShell(script: string, env: Record<string, string>, timeoutMs: number): Promise<string> {
  // Absolute path: a `powershell.exe` earlier on the user's PATH must not get
  // to answer with a software key and call it the TPM.
  const { stdout } = await execFileAsync(
    windowsSystemToolPath("powershell"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024, env: { ...process.env, ...env } },
  );
  return stdout;
}

export interface TpmAnchorOptions {
  /** Test seam: runs a script with the given environment and returns its stdout. */
  run?: (script: string, env: Record<string, string>) => Promise<string>;
  timeoutMs?: number;
  /** Where the endorsement key description is cached; read every time without it. */
  endorsementCachePath?: string;
}

function firstJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("{"));
  if (line === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(line.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readEndorsement(
  run: (script: string, env: Record<string, string>) => Promise<string>,
  cachePath: string | undefined,
): Promise<Record<string, unknown>> {
  if (cachePath) {
    const cached = await readFile(cachePath, "utf8").then(firstJsonLine).catch((): Record<string, unknown> => ({}));
    if (typeof cached["ekPublicKey"] === "string") return cached;
  }
  const endorsement = firstJsonLine(await run(ENDORSEMENT_SCRIPT, {}).catch(() => ""));
  if (cachePath && typeof endorsement["ekPublicKey"] === "string") {
    await writeFile(cachePath, `${JSON.stringify(endorsement)}\n`, "utf8").catch(() => undefined);
  }
  return endorsement;
}

/**
 * Sign `message` with the anchor key and gather the endorsement material, or
 * null when this machine offers no TPM identity key. Never throws.
 */
export async function collectTpmAnchor(message: string, options: TpmAnchorOptions = {}): Promise<TpmAnchorMaterial | null> {
  if (process.platform !== "win32" || typeof message !== "string" || message === "") return null;
  const run = options.run ?? ((script: string, env: Record<string, string>) => runPowerShell(script, env, options.timeoutMs ?? 20_000));
  try {
    const signed = firstJsonLine(await run(COLLECT_SCRIPT, { ROTK_TPM_MESSAGE_B64: Buffer.from(message, "utf8").toString("base64") }));
    const endorsement = await readEndorsement(run, options.endorsementCachePath);
    return parseTpmAnchorOutput(JSON.stringify({ ...endorsement, ...signed }));
  } catch {
    return null;
  }
}

/**
 * Recover the server's secret through the TPM, or null when the TPM (or
 * Windows, for a non-elevated launcher) refuses. Never throws.
 */
export async function activateTpmAnchor(credentialBlob: string, encryptedSecret: string, options: TpmAnchorOptions = {}): Promise<string | null> {
  if (process.platform !== "win32") return null;
  if (b64(credentialBlob, 1024) === null || b64(encryptedSecret, 1024) === null) return null;
  const activation = Buffer.concat([Buffer.from(credentialBlob, "base64"), Buffer.from(encryptedSecret, "base64")]).toString("base64");
  const run = options.run ?? ((script: string, env: Record<string, string>) => runPowerShell(script, env, options.timeoutMs ?? 15_000));
  try {
    const stdout = await run(ACTIVATE_SCRIPT, { ROTK_TPM_ACTIVATION: activation });
    const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
    return line === undefined ? null : b64(line, 64);
  } catch {
    return null;
  }
}

// --- enrolment against the server ------------------------------------------

export interface TpmEnrolmentEndpoints {
  readonly beginUrl: string;
  readonly completeUrl: string;
}

export type TpmEnrolmentOutcome =
  | { readonly state: "activated" }
  | { readonly state: "skipped"; readonly reason: "no-endorsement-key" }
  | { readonly state: "failed"; readonly reason: string };

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || payload === null || typeof payload !== "object") return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Enrol the anchor: tell the server which identity key signs and under which
 * EK, run the activation it hands back, return the recovered secret. One
 * round trip once the key is activated ("activated" straight away), three the
 * first time. Never throws; a failed enrolment costs this launch nothing, the
 * server just sees an unactivated anchor.
 */
export async function enrolTpmAnchor(
  endpoints: TpmEnrolmentEndpoints,
  playerKey: string,
  launcherVersion: string,
  material: TpmAnchorMaterial,
  options: TpmAnchorOptions & { fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {},
): Promise<TpmEnrolmentOutcome> {
  if (material.ek === null) return { state: "skipped", reason: "no-endorsement-key" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 8_000;
  const begin = await postJson(fetchImpl, endpoints.beginUrl, {
    launcherKey: playerKey,
    launcherVersion,
    anchor: { publicKey: material.proof.publicKey, tpmPublic: material.proof.tpmPublic, ek: material.ek },
  }, timeoutMs);
  if (begin === null) return { state: "failed", reason: "enroll-begin refused or unreachable" };
  if (begin["state"] === "activated") return { state: "activated" };
  if (begin["state"] !== "activate") return { state: "failed", reason: "unexpected enroll-begin answer" };
  const activationId = begin["activationId"];
  const credentialBlob = begin["credentialBlob"];
  const encryptedSecret = begin["encryptedSecret"];
  if (typeof activationId !== "string" || typeof credentialBlob !== "string" || typeof encryptedSecret !== "string") {
    return { state: "failed", reason: "malformed activation" };
  }
  const secret = await activateTpmAnchor(credentialBlob, encryptedSecret, options);
  if (secret === null) return { state: "failed", reason: "the TPM did not activate the credential" };
  const complete = await postJson(fetchImpl, endpoints.completeUrl, { launcherKey: playerKey, activationId, secret }, timeoutMs);
  if (complete === null || complete["state"] !== "activated") return { state: "failed", reason: "enroll-complete refused" };
  return { state: "activated" };
}
