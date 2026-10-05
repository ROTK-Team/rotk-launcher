import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { retryFs } from "./fs-safe.js";
import type { InstalledClientConfig, LauncherConfig } from "./config-store.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { serverList } from "./runtime-config.js";
import { GAME_LOCALE, synchronizeClientConfig, synchronizeUserOptions, validateLocalCreateSessionUrl } from "./client-config.js";
import type { AppLocale } from "../../shared/locale.js";
import { validateInstallDestination } from "./path-policy.js";
import type { PlayerIdentity } from "./player-identity.js";
import { startLocalSessionGateway } from "./session-gateway.js";
import { readInstallationMarker } from "./installer.js";
import {
  assertLaunchTicketFresh,
  createLaunchTicket,
  type LaunchTicketIdentity,
} from "./launch-ticket.js";
import {
  assertGameplayPatchState,
  type GameplayPatchMode,
} from "./gameplay-patch.js";
import { assertVivoxCompatibility, deployVivoxCompatibility } from "./vivox-client.js";
import { prepareInterfaceInputProfile } from "./interface-input-profile.js";
import { prepareWeaponStanceProfile, WEAPON_STANCE_ENABLED } from "./weapon-stance-profile.js";

const GAME_STARTUP_STABILITY_MS = 3_000;

/**
 * What one attestation attempt produced.
 * - `attested`: a block to carry with the ticket request.
 * - `not-applicable`: the server has no attestation to run (no policy yet, or
 *   unconfigured). Launch as usual — the ticket route stays the authority.
 * - `unavailable`: attestation should have run but could not (service
 *   unreachable, files unreadable, malformed response). No block is sent, and
 *   if enforcement then blocks the launch, the reason explains why instead of
 *   the ticket route's opaque "update the launcher".
 */
export type AttestationOutcome =
  | {
      readonly status: "attested";
      readonly block: unknown;
      /**
       * The fingerprint read for the slots the challenge asked (#320 §B). It
       * is what the TPM proof inside the block was signed over, so the ticket
       * request must carry exactly this object and not a fingerprint read at
       * another time.
       */
      readonly hwid?: Record<string, string>;
      /** Server-directed shotgun sprint client-patch mode for this launch. */
      readonly clientPatchMode: GameplayPatchMode;
    }
  | { readonly status: "not-applicable"; readonly clientPatchMode: GameplayPatchMode }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly clientPatchMode: GameplayPatchMode;
    };

export interface LaunchRequest {
  config: LauncherConfig;
  identity: PlayerIdentity;
  runtime: RuntimeConfig;
  /** Launcher UI language; the game temporarily remains in English. */
  locale: AppLocale;
  logsRoot: string;
  bundledShimPath: string;
  bundledVivoxProxyPath: string;
  bundledVivoxRuntimePath: string;
  bundledGameplayPatchPath: string;
  /** Anticheat module the Vivox proxy loads by name from the game root. */
  bundledRotkcPath: string;
  /**
   * Mode reapplied when the server does not run attestation (development or
   * unconfigured backend). The production path always uses the signed
   * challenge directive instead.
   */
  clientPatchModeFallback: GameplayPatchMode;
  /**
   * Integrity attestation hook. The launcher never self-exempts: it reports
   * what it observed and lets the backend decide what an absent attestation
   * means.
   */
  attest?: () => Promise<AttestationOutcome>;
  /** This launcher's version, sent so the server's update gate can act. */
  launcherVersion?: string;
  /** Raw hardware fingerprint; the server hashes it (see machine-identity.ts). */
  hwid?: Record<string, string>;
  /** Best-effort telemetry only. Diagnostic failures never control the game lifecycle. */
  diagnostics?: GameLaunchDiagnostics;
  onExit(exitCode: number | null): void;
}

export interface GameLaunchDiagnostics {
  onPreparing?(): Promise<void>;
  onIdentity(identity: { displayName: string; steamId: string }): void;
  onSpawned(pid: number): void;
  onOutput(stream: "stdout" | "stderr", text: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): Promise<void>;
}

function diagnosticCallback(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* Diagnostic collection must remain fail-open. */ }
}

/**
 * Turn an attestation outcome plus the launcher's version and fingerprint into
 * the ticket request options. A clean measurement carries its block; a
 * not-applicable one carries nothing; an unavailable one records why so an
 * enforced refusal can name the real cause. The version and HWID ride along
 * regardless, so the update gate and HWID capture work even with no attestation.
 */
function ticketRequestOptions(
  request: LaunchRequest,
  outcome: AttestationOutcome,
): { attestation?: unknown; attestationUnavailableReason?: string; launcherVersion?: string; hwid?: Record<string, string> } {
  const base: { launcherVersion?: string; hwid?: Record<string, string> } = {};
  if (request.launcherVersion) base.launcherVersion = request.launcherVersion;
  // An attested launch answers the slots its challenge named, and its TPM proof
  // is bound to that exact vector; the fingerprint read before the launch is
  // the fallback for a launch that could not attest.
  const hwid = outcome.status === "attested" && outcome.hwid !== undefined ? outcome.hwid : request.hwid;
  if (hwid && Object.keys(hwid).length > 0) base.hwid = hwid;
  if (outcome.status === "attested") return { ...base, attestation: outcome.block };
  if (outcome.status === "unavailable") {
    return { ...base, attestationUnavailableReason: outcome.reason };
  }
  return base;
}

async function validateMarker(installation: InstalledClientConfig): Promise<void> {
  const marker = await readInstallationMarker(installation.root);
  if (!marker) {
    throw new Error("L’installation ROTK est incomplète : son marqueur est introuvable.");
  }
  if (marker.schemaVersion !== 1 || marker.installId !== installation.installId) {
    throw new Error("L’installation ROTK ne correspond plus à celle enregistrée par le launcher.");
  }
}

export async function validateInstalledClient(installation: InstalledClientConfig): Promise<string> {
  const root = await validateInstallDestination(installation.root);
  await validateMarker({ ...installation, root });

  const executable = await stat(join(root, "H1Z1.exe")).catch(() => null);
  if (!executable?.isFile()) throw new Error("H1Z1.exe est introuvable dans l’installation ROTK.");
  if (!existsSync(join(root, "steam_api64.original.dll"))) {
    throw new Error("La sauvegarde de steam_api64.dll est absente. Réimporte le client.");
  }
  return root;
}

function sanitizedEnvironment(
  identity: Pick<LaunchTicketIdentity, "displayName" | "steamId">,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLocaleUpperCase("en-US");
    if (
      normalized.startsWith("H1Z1_") ||
      normalized === "STEAMID" ||
      normalized === "STEAMAPPID" ||
      normalized === "STEAMGAMEID"
    ) {
      delete environment[key];
    }
  }
  environment.H1Z1_OVERRIDE_PERSONA = identity.displayName;
  environment.H1Z1_OVERRIDE_STEAMID = identity.steamId;
  environment.STEAMID = identity.steamId;
  return environment;
}

async function prepareClient(
  request: LaunchRequest,
  root: string,
  localCreateSessionUrl: string,
  launchIdentity: LaunchTicketIdentity,
  clientPatchMode: GameplayPatchMode,
): Promise<string> {
  // All subsequent I/O and the spawned process use the same physical root that
  // passed policy validation. This prevents a logical junction alias from
  // steering configuration and execution to a different tree.
  const activeShimPath = join(root, "steam_api64.dll");
  await retryFs(() => copyFile(request.bundledShimPath, activeShimPath));
  await retryFs(() => copyFile(request.bundledRotkcPath, join(root, "rotkc.dll")));
  await assertVivoxCompatibility(root);
  // The attestation pass has already installed or removed the shotgun sprint
  // proxy for the mode the server directed; preparation only rechecks it so a
  // concurrent drift cannot ride into the process.
  await assertGameplayPatchState(root, clientPatchMode);

  await prepareWeaponStanceProfile(root,
    join(request.logsRoot, request.config.installation!.installId, "input-profile"), WEAPON_STANCE_ENABLED);
  await prepareInterfaceInputProfile(
    root,
    join(request.logsRoot, request.config.installation!.installId, "input-profile"),
  );

  const configPath = join(root, "ClientConfig.ini");
  const configBackupPath = join(root, "ClientConfig.original.ini");
  if (!existsSync(configBackupPath)) await copyFile(configPath, configBackupPath);
  const synchronized = synchronizeClientConfig(
    await readFile(configPath, "utf8"),
    request.runtime,
    localCreateSessionUrl,
  );
  await writeFile(configPath, synchronized, "ascii");
  await writeFile(join(root, "steam_persona_name.txt"), `${launchIdentity.displayName}\n`, "utf8");

  await updateUserOptions(root, synchronizeUserOptions);

  const battleyePath = join(root, "BattlEye", "BEClient_x64.cfg");
  if (existsSync(battleyePath)) {
    const current = await readFile(battleyePath, "utf8");
    const patched = current.replace(/MasterPort\s+\d+/i, "MasterPort 20099");
    if (patched !== current) await writeFile(battleyePath, patched, "ascii");
  }
  return root;
}

// Best effort and atomic: a locked or read-only UserOptions.ini must never
// block Play, and an interrupted write must not truncate the player's settings.
async function updateUserOptions(root: string, update: (options: string) => string): Promise<void> {
  const path = join(root, "UserOptions.ini");
  if (!existsSync(path)) return;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await readFile(path, "utf8");
    const next = update(current);
    if (next === current) return;
    await writeFile(temporaryPath, next, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    console.warn("UserOptions.ini was not updated; launching anyway.", error);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function buildLaunchArguments(
  launchTicket: string,
  runtime: RuntimeConfig,
  logsRoot: string,
  installId: string,
  localCreateSessionUrl: string,
  locale: AppLocale,
): string[] {
  const gatewayCreateSession = validateLocalCreateSessionUrl(localCreateSessionUrl);
  const voiceGrantOrigin = validateVoiceGrantOrigin(runtime.voiceGrantOrigin);
  const localLogs = join(logsRoot, installId, "local");
  const failureLogs = join(logsRoot, installId, "failure");
  return [
    `sessionid=${launchTicket}`,
    `server=${serverList(runtime)}`,
    `SteamGatewayUrl=${gatewayCreateSession}`,
    `VivoxGrantUrl=${voiceGrantOrigin}`,
    // The native stage enumerates this observer-local shim lobby. Steam IDs and
    // actor IDs are supplied later by the authenticated server/UI bridge.
    "thirdPartyCommandLine=+connect_lobby109775241000000001",
    `CommandQueue:motd_uri=${runtime.gatewayOrigin}/`,
    `CommandQueue:cb_uri=${runtime.gatewayOrigin}/`,
    `CommandQueue:eula_uri=${runtime.gatewayOrigin}/`,
    `LaunchTelemetry:Url=${runtime.gatewayOrigin}/h1z1xx/live/`,
    // Override only this process, preserving any saved ClientConfig language.
    `Internationalization:Locale=${GAME_LOCALE[locale]}`,
    "Logging:ConsoleLogLevel=999",
    "Logging:FileLogLevel=999",
    "Logging:LocalLogLevel=999",
    `Logging:Directory=${join(logsRoot, installId)}`,
    `Logging:LocalDirectory=${localLogs}`,
    `Logging:FailureDirectory=${failureLogs}`,
  ];
}

function validateVoiceGrantOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid ROTK voice grant origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Invalid ROTK voice grant origin");
  }
  return parsed.origin;
}

function windowsExitCode(code: number | null): string {
  if (code === null) return "inconnu";
  return `0x${(code >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

function waitForStableStartup(
  child: ChildProcess,
  durationMs = GAME_STARTUP_STABILITY_MS,
): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.reject(new Error(
      `H1Z1 s’est fermé pendant son initialisation (code Windows ${windowsExitCode(child.exitCode)}).`,
    ));
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(
        `H1Z1 s’est fermé pendant son initialisation (code Windows ${windowsExitCode(code)}).`,
      ));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new Error(`Windows n’a pas pu initialiser H1Z1 : ${error.message}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    child.once("exit", onExit);
    child.once("error", onError);
    // Cover the narrow race where the process exits between the initial
    // exitCode check and listener registration.
    if (child.exitCode !== null) onExit(child.exitCode);
  });
}

export class GameLauncher {
  private child: ChildProcess | null = null;

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  async launch(request: LaunchRequest): Promise<number> {
    if (this.isRunning()) throw new Error("H1Z1 est déjà lancé depuis cette installation.");
    const installation = request.config.installation;
    if (!installation) throw new Error("Installe d’abord le client ROTK.");
    const installationRoot = await validateInstalledClient(installation);
    const localLogs = join(request.logsRoot, installation.installId, "local");
    const failureLogs = join(request.logsRoot, installation.installId, "failure");
    await mkdir(localLogs, { recursive: true });
    await mkdir(failureLogs, { recursive: true });

    // Repair the mandatory Vivox/crouch compatibility proxy before
    // attestation. The shotgun sprint proxy is applied by the attestation pass
    // itself, once the signed challenge has named its mode; an unknown
    // dinput8.dll blocks the launch instead of being silently deleted.
    await deployVivoxCompatibility(
      installationRoot,
      request.bundledVivoxProxyPath,
      request.bundledVivoxRuntimePath,
    );

    // Integrity attestation runs before the ticket exists: the whole point is
    // that a tampered installation never obtains one.
    const outcome = request.attest
      ? await request.attest()
      : { status: "not-applicable", clientPatchMode: request.clientPatchModeFallback } as const;

    // The durable website key reaches only the HTTPS account service. H1Z1
    // receives a short ticket and the Steam identity authenticated by it.
    let launchIdentity = await createLaunchTicket(
      request.identity.playerKey,
      request.runtime.launchTicketUrl,
      ticketRequestOptions(request, outcome),
    );
    let sessionGateway = await startLocalSessionGateway(launchIdentity.ticket);

    try {
      await prepareClient(
        request,
        installationRoot,
        sessionGateway.createSessionUrl,
        launchIdentity,
        outcome.clientPatchMode,
      );

      // Capture the prepared asset/configuration state before the first frame.
      // The freshness check below also covers time spent collecting diagnostics.
      await Promise.resolve().then(() => request.diagnostics?.onPreparing?.()).catch(() => undefined);

      // Client preparation may outlive the short launch ticket on a first run
      // or a slow disk. Refresh only after that expensive work, then rewrite
      // the identity-bound local gateway/configuration before spawning H1Z1.
      try {
        assertLaunchTicketFresh(launchIdentity);
      } catch {
        await sessionGateway.close().catch(() => undefined);
        // A fresh ticket needs a fresh attestation: the first challenge was
        // consumed by the request above and is not replayable.
        const refreshed = request.attest
          ? await request.attest()
          : { status: "not-applicable", clientPatchMode: request.clientPatchModeFallback } as const;
        launchIdentity = await createLaunchTicket(
          request.identity.playerKey,
          request.runtime.launchTicketUrl,
          ticketRequestOptions(request, refreshed),
        );
        sessionGateway = await startLocalSessionGateway(launchIdentity.ticket);
        await prepareClient(
          request,
          installationRoot,
          sessionGateway.createSessionUrl,
          launchIdentity,
          refreshed.clientPatchMode,
        );
        assertLaunchTicketFresh(launchIdentity);
      }

      const args = buildLaunchArguments(
        launchIdentity.ticket,
        request.runtime,
        request.logsRoot,
        installation.installId,
        sessionGateway.createSessionUrl,
        request.locale,
      );

      const executable = join(installationRoot, "H1Z1.exe");
      diagnosticCallback(() => request.diagnostics?.onIdentity({ displayName: launchIdentity.displayName, steamId: launchIdentity.steamId }));
      const child = spawn(executable, args, {
        cwd: installationRoot,
        env: sanitizedEnvironment(launchIdentity),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
        shell: false,
      });
      if (!child.pid) {
        // A failed spawn emits 'error' on the next tick even though no process
        // exists. The launch caller records the failure; absorb the event here.
        child.once("error", () => undefined);
        throw new Error("Windows n’a pas retourné l’identifiant du processus H1Z1.");
      }
      this.child = child;
      for (const stream of ["stdout", "stderr"] as const) {
        child[stream]?.setEncoding("utf8");
        child[stream]?.on("data", (text: string) => diagnosticCallback(() => request.diagnostics?.onOutput(stream, text)));
        child[stream]?.on("error", () => undefined);
      }
      diagnosticCallback(() => request.diagnostics?.onSpawned(child.pid!));
      let finalized = false;
      const finalize = (code: number | null, signal: NodeJS.Signals | null = null): void => {
        if (finalized) return;
        finalized = true;
        if (this.child === child) this.child = null;
        void sessionGateway.close().catch(() => undefined);
        // Preserve the local gateway/game lifecycle, but keep the launcher alive
        // until the final report has been persisted when its window was closed.
        const collected = Promise.resolve().then(() => request.diagnostics?.onExit(code, signal));
        void collected.catch(() => undefined).finally(() => request.onExit(code));
      };
      child.once("exit", (code, signal) => finalize(code, signal));
      child.once("error", () => finalize(null));
      // Do not report IN GAME for a native process that dies in its loader or
      // PreInitialize path. This was the visible failure mode of launcher
      // 1.4.0: H1Z1 exited with 0xc00000fd immediately after spawn, while the
      // renderer had already switched to the running state.
      await waitForStableStartup(child);
      child.unref();
      return child.pid;
    } catch (error) {
      await sessionGateway.close().catch(() => undefined);
      throw error;
    }
  }
}

export const gameLauncherInternals = {
  sanitizedEnvironment,
  validateMarker,
  validateInstalledClient,
  prepareClient,
  buildLaunchArguments,
  validateVoiceGrantOrigin,
  windowsExitCode,
};
