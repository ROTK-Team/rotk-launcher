import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join, basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import {
  IPC_CHANNELS,
  type AssetSyncProgress,
  type AssetSyncStatus,
  type AssetSyncSummary,
  type AssetSyncWarning,
  type ClientSourceKind,
  type LauncherPhase,
  type LauncherSnapshot,
  type OperationResult,
  type PlayerIdentitySummary,
} from "../shared/contracts.js";
import { isAppLocale, type AppLocale } from "../shared/locale.js";
import {
  DEFAULT_PLAYER_ROLE,
  DEFAULT_SERVER_ID,
  LAUNCH_PROFILE_IDS,
  isLaunchProfileId,
  isPlayerRole,
  isServerId,
  launchProfileId,
  type LaunchProfileId,
  type PlayerRole,
  type ServerId,
} from "../shared/launch-profile.js";
import {
  APP_NAME,
  RECOMMENDED_INSTALL_PARENT_NAME,
  ROTK_INSTALL_DIRECTORY_NAME,
  resolveBundledShimPath,
  resolveBundledVivoxProxyPath,
  resolveBundledVivoxRuntimePath,
  resolveBundledGameplayPatchPath,
  resolveBundledDiagnosticsPath,
} from "./constants.js";
import { ConfigStore } from "./services/config-store.js";
import { adoptExistingClient, installClient } from "./services/installer.js";
import {
  GameLauncher,
  validateInstalledClient,
  type AttestationOutcome,
} from "./services/game-launcher.js";
import { HWID_CORE_SLOTS, collectHwid } from "./services/machine-identity.js";
import { collectTpmProof } from "./services/tpm-identity.js";
import { collectTpmAnchor, enrolTpmAnchor } from "./services/tpm-anchor.js";
import { tpmBindingMessage } from "../shared/attestation.js";
import { classifyClientSource, validateInstallDestination } from "./services/path-policy.js";
import { locateSteamClient } from "./services/steam-locator.js";
import {
  runtimeConfigFor,
  runtimeConfigList,
  type RuntimeConfig,
} from "./services/runtime-config.js";
import {
  fetchServerStatus,
  SERVER_STATUS_POLL_INTERVAL_MS,
  UNKNOWN_SERVER_STATUS,
  type ServerStatus,
} from "./services/server-status.js";
import { UpdateFeedService } from "./services/update-feed.js";
import { AssetSyncService } from "./services/asset-sync.js";
import { LauncherUpdateService } from "./services/launcher-update.js";
import { hasLauncherUpdate } from "../shared/launcher-update.js";
import electronUpdater from "electron-updater";
import { localizeServiceError, MAIN_COPY } from "./i18n.js";
import { identityFromPlayerKey } from "./services/player-identity.js";
import { PlayerKeyStore, type PlayerKeySet } from "./services/player-key-store.js";
import { readInstallationMarker } from "./services/installer.js";
import {
  BASE_MANIFEST_URL,
  loadBaseManifest,
  mergeExpectedFiles,
  readLauncherOverrides,
} from "./services/base-manifest.js";
import {
  AttestationUnavailableError,
  buildAttestationResult,
  measureInstallation,
  requestAttestationChallenge,
  type AttestationProgress,
} from "./services/integrity-attestation.js";
import { DiagnosticController } from "./services/diagnostic-controller.js";
import { StartupLog } from "./services/startup-log.js";
import { describeSystemError, isSystemError } from "./services/system-error.js";
import { redactDiagnosticText } from "./services/diagnostic-redaction.js";
import { createHash } from 'node:crypto';
import { uploadDiagnostic } from "./services/diagnostic-upload.js";
import { collectDiagnosticClientContext } from "./services/diagnostic-client-context.js";
import type { DiagnosticSessionContext } from "./services/diagnostic-reports.js";
import type { DiagnosticCaptureRequest, DiagnosticExportRequest, DiagnosticState } from "../shared/diagnostics.js";
import {
  GAMEPLAY_MARKER_SHA256,
  GAMEPLAY_PATCH_SHA256,
  applyGameplayPatchMode,
  readCachedGameplayPatchMode,
  recordGameplayPatchState,
  type GameplayPatchMode,
} from "./services/gameplay-patch.js";

app.setName(APP_NAME);
if (!app.isPackaged && process.env.ROTK_USER_DATA_DIR) {
  app.setPath("userData", resolve(process.env.ROTK_USER_DATA_DIR));
} else {
  // Keep the installation record stable across launcher versions, executable
  // names and installation directories. Electron's implicit directory is
  // product-name based, which made development and packaged builds drift.
  app.setPath("userData", join(app.getPath("appData"), APP_NAME));
}
// Breadcrumbs from here to the first paint, in %APPDATA%\ROTK Launcher\startup.log.
const startupLog = new StartupLog(app.getPath("userData"));
const singleInstanceLock = app.requestSingleInstanceLock();
if (singleInstanceLock) {
  startupLog.begin(
    `start ${app.getVersion()} packaged=${app.isPackaged} electron=${process.versions.electron} windows=${process.getSystemVersion()}`,
  );
} else {
  // Another launcher owns this user's lock: it receives "second-instance" and
  // this process leaves. Nothing else may run in it — the lifecycle hooks at
  // the bottom are registered behind the lock, otherwise whenReady() would
  // start a full initialize() in a process that is already quitting, racing
  // the owner on the same files (2.0.14 reports: a first instance stuck
  // without a window made every further click spawn a process that died at
  // once).
  app.quit();
}

const usesIsolatedDevelopmentData = !app.isPackaged && Boolean(process.env.ROTK_USER_DATA_DIR);
const legacyUserDataDirectories = usesIsolatedDevelopmentData
  ? []
  : [
      ...["rotk-launcher", "h1z1-server-kotk"].map((name) => join(app.getPath("appData"), name)),
      ...(!app.isPackaged ? [join(app.getAppPath(), ".dev-data")] : []),
    ];

let mainWindow: BrowserWindow | null = null;
let configStore: ConfigStore;
let playerKeyStore: PlayerKeyStore;
let updateFeed: UpdateFeedService;
let assetSync: AssetSyncService;
let launcherUpdate: LauncherUpdateService;
let diagnostics: DiagnosticController;
let debugSettingWrite = false;
// Resolved once initialize() has built the services the IPC handlers use. The
// window is created before that, so handlers wait here instead of touching an
// undefined store.
let servicesInitialized = false;
let resolveServicesReady: () => void = () => undefined;
const servicesReady = new Promise<void>((resolve) => {
  resolveServicesReady = resolve;
});
const gameLauncher = new GameLauncher();
const LAUNCHER_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
// The window is shown at the latest this long after its creation, painted or not.
const WINDOW_SHOW_DEADLINE_MS = 5_000;
let installAbortController: AbortController | null = null;
let phase: LauncherPhase = "unconfigured";
let sourceRoot: string | null = null;
let destinationRoot: string | null = null;
let sourceKind: ClientSourceKind | null = null;
let sourceDetected = false;
let destinationRecommended = false;
let progress: LauncherSnapshot["progress"] = null;
let updates: LauncherSnapshot["updates"] = [];
let lastErrorRaw: string | null = null;
// Set when the server refuses a launch for launcher_update_required: the update
// becomes mandatory (Play is blocked) until a newer launcher is installed.
let updateRequired = false;
let gamePid: number | null = null;
let currentLocale: AppLocale = "en";
let playerKeys: PlayerKeySet = {};
let selectedServerId: ServerId = DEFAULT_SERVER_ID;
let selectedRole: PlayerRole = DEFAULT_PLAYER_ROLE;
let serverStatus: Partial<Record<ServerId, ServerStatus>> = {};
let quitWhenGameExits = false;
let crashReportRequests = 0;
let assetSyncEnabled = true;
let assetSyncRunning = false;
let assetSyncStatus: AssetSyncStatus = "idle";
let assetSyncWarning: AssetSyncWarning | null = null;
let assetSyncProgress: AssetSyncProgress | null = null;
let attestationProgress: AttestationProgress | null = null;
let assetSyncPackVersion: string | null = null;
let assetSyncLastAt: string | null = null;

function diagnosticCopy(): { failed: string; invalid: string; save: string; exists: string; settings: string } {
  return currentLocale === "fr" ? {
    failed: "Le diagnostic n’a pas pu être terminé. Les rapports déjà enregistrés restent disponibles.",
    invalid: "La demande de diagnostic est invalide.", save: "Enregistrer le rapport de diagnostic ROTK",
    exists: "Ce fichier existe déjà. Choisis un autre nom pour conserver les deux rapports.",
    settings: "Le réglage de capture pourra être changé une fois la session terminée.",
  } : {
    failed: "The diagnostic operation could not be completed. Previously saved reports are still available.",
    invalid: "The diagnostic request is invalid.", save: "Save ROTK diagnostic report",
    exists: "This file already exists. Choose another name to keep both reports.",
    settings: "Capture settings can be changed after the game session ends.",
  };
}

async function diagnosticContext(runtime = activeRuntime()): Promise<DiagnosticSessionContext> {
  const config = await configStore.load();
  return {
    launcherVersion: app.getVersion(), serverId: runtime.id, serverLabel: runtime.label,
    role: config.role ?? selectedRole, installationRoot: config.installation?.root,
    installId: config.installation?.installId, clientBuildId: config.installation?.clientBuildId,
    logsRoot: join(app.getPath("userData"), "logs"), assetPackVersion: assetSyncPackVersion ?? undefined,
    assetSyncEnabled: config.assetSyncEnabled !== false,
    electronVersion: process.versions.electron, nodeVersion: process.versions.node,
    diagnosticSchemaVersion: 1,
    diagnosticCredentialHash: activeKey() ? createHash('sha256').update(activeKey()!).digest('hex') : null,
  };
}

function validDiagnosticDescription(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4000;
}

function diagnosticWorkInProgress(): boolean {
  return debugSettingWrite || crashReportRequests > 0 || Boolean(diagnostics?.isBusy());
}

function bundledResourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Installation annulée.";
  // Wrapped errors ("... could not be installed") keep the system cause.
  const cause = error instanceof Error ? error.cause : undefined;
  if (isSystemError(error)) return describeSystemError(error, bundledResourcesRoot());
  if (error instanceof Error && isSystemError(cause)) {
    return `${error.message} ${describeSystemError(cause, bundledResourcesRoot())}`;
  }
  if (error instanceof Error) return error.message;
  return "Une erreur inattendue est survenue.";
}

function logOperationError(error: unknown): void {
  const details = error as NodeJS.ErrnoException | null;
  const cause = (error instanceof Error ? error.cause : undefined) as NodeJS.ErrnoException | undefined;
  startupLog.mark(
    "operation-failed",
    redactDiagnosticText([details?.code, details?.syscall, details?.path, details?.message, cause?.code, cause?.path]
      .filter(Boolean).join(" | ")),
  );
  void diagnostics?.recordLauncherError("launcher_operation_failed", error).catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return localizeServiceError(rawErrorMessage(error), currentLocale);
}

async function installationRoot(): Promise<string | null> {
  return (await configStore.load()).installation?.root ?? null;
}

/**
 * The single source of every endpoint the client is handed. Selecting a server
 * switches this whole contract at once; nothing downstream reads a URL that did
 * not come from here.
 */
function activeRuntime(): RuntimeConfig {
  return runtimeConfigFor(selectedServerId);
}

function activeProfile(): LaunchProfileId {
  return launchProfileId(selectedServerId, selectedRole);
}

/** The credential the next launch authenticates with, or null when unset. */
function activeKey(): string | null {
  return playerKeys[activeProfile()] ?? null;
}

function isSelectionLocked(): boolean {
  return gameLauncher.isRunning() || phase === "launching" || phase === "running";
}

/**
 * Refreshes every server's public population. Both are polled, not just the
 * selected one: the server menu shows where the players actually are, which is
 * most of the reason to open it.
 */
async function refreshServerStatus(): Promise<void> {
  const samples = await Promise.all(runtimeConfigList().map(async (runtime) => [
    runtime.id,
    await fetchServerStatus(runtime),
  ] as const));
  serverStatus = Object.fromEntries(samples);
  await broadcastSnapshot();
}

function recommendedDestinationPath(): string {
  const systemDrive = process.env.SystemDrive ?? "C:";
  return join(`${systemDrive}${sep}`, RECOMMENDED_INSTALL_PARENT_NAME, ROTK_INSTALL_DIRECTORY_NAME);
}

/**
 * Pre-fill the ROTK destination with the recommended default so a detected or
 * freshly selected Steam client only needs one Install click. Best-effort: an
 * already existing folder (the installer requires an empty target) or a
 * failing path policy leaves the destination for manual selection.
 */
async function applyRecommendedDestination(): Promise<void> {
  if (sourceKind !== "copy-required" || !sourceRoot) return;
  try {
    const candidate = recommendedDestinationPath();
    const existing = await stat(candidate).catch(() => null);
    if (existing) return;
    destinationRoot = await validateInstallDestination(candidate, sourceRoot);
    destinationRecommended = true;
    phase = "destination-selected";
  } catch {
    destinationRoot = null;
    destinationRecommended = false;
  }
}

function assetSyncSummary(): AssetSyncSummary {
  return {
    enabled: assetSyncEnabled,
    status: assetSyncEnabled ? assetSyncStatus : "disabled",
    packVersion: assetSyncPackVersion,
    lastSyncAt: assetSyncLastAt,
    progress: assetSyncProgress,
    warning: assetSyncWarning,
  };
}

/**
 * Synchronize the custom asset packs with the published feed. With `soft`,
 * a failure after at least one completed sync is downgraded to a warning so
 * the feed never prevents the game from launching with the assets on disk.
 */
async function runAssetSync(mode: "sync" | "verify", soft: boolean): Promise<OperationResult> {
  const root = await installationRoot();
  if (!root) return { ok: false, error: MAIN_COPY[currentLocale].clientNotReady };
  if (!assetSyncEnabled) return { ok: true };
  if (assetSyncRunning) return { ok: false, error: MAIN_COPY[currentLocale].assets.busy };
  assetSyncRunning = true;
  assetSyncStatus = "checking";
  assetSyncWarning = null;
  assetSyncProgress = null;
  await broadcastSnapshot();
  try {
    const outcome = mode === "verify" ? await assetSync.verify(root) : await assetSync.sync(root);
    assetSyncPackVersion = outcome.packVersion;
    assetSyncLastAt = new Date().toISOString();
    if (outcome.status === "offline-warning") {
      assetSyncStatus = "warning";
      assetSyncWarning = "feed-unavailable";
    } else {
      assetSyncStatus = "up-to-date";
    }
    return { ok: true };
  } catch (error) {
    if (soft && (await assetSync.readState().catch(() => null))) {
      assetSyncStatus = "warning";
      assetSyncWarning = "sync-failed";
      return { ok: true };
    }
    assetSyncStatus = "error";
    return operationError(error);
  } finally {
    assetSyncRunning = false;
    assetSyncProgress = null;
    await broadcastSnapshot();
  }
}

/**
 * Runs one integrity attestation pass and returns the block the launch ticket
 * request carries. Returns null only when attestation genuinely cannot run
 * (no policy published, manifest unreachable and never cached) — it is the
 * backend, not the launcher, that decides whether a null is acceptable.
 *
 * A tampered installation still attests: the deviations are reported and the
 * evidence will not match, so the rejection is logged for the admin studio
 * instead of being silently hidden by the client.
 */
async function attestInstallation(
  playerKey: string,
  runtime: RuntimeConfig,
): Promise<AttestationOutcome> {
  const root = await installationRoot();
  const userDataDirectory = app.getPath("userData");
  const launcherVersion = app.getVersion();
  // A server that does not run attestation (no policy yet, development
  // backend) gets the last mode this player was told to use; a fresh machine
  // starts on the shipped default. Production always uses the signed
  // challenge directive below.
  const fallbackMode: GameplayPatchMode =
    await readCachedGameplayPatchMode(userDataDirectory) ?? "patched";
  if (!root) return { status: "not-applicable", clientPatchMode: fallbackMode };
  try {
    const marker = await readInstallationMarker(root);
    if (!marker) return { status: "not-applicable", clientPatchMode: fallbackMode };

    const challenge = await requestAttestationChallenge(
      playerKey,
      runtime.attestationChallengeUrl,
      launcherVersion,
    );
    // The signed challenge names the client-patch mode this launch must use.
    // A server that predates the field expects a clean tree, so the safe
    // default is "clean" rather than silently keeping a local patch.
    const clientPatchMode: GameplayPatchMode = challenge.clientPatchMode ?? "clean";
    await applyGameplayPatchMode(
      root,
      resolveBundledGameplayPatchPath(),
      clientPatchMode,
    );
    await recordGameplayPatchState(userDataDirectory, {
      mode: clientPatchMode,
      dllSha256: clientPatchMode === "patched" ? GAMEPLAY_PATCH_SHA256 : null,
      markerSha256: clientPatchMode === "patched" ? GAMEPLAY_MARKER_SHA256 : null,
      policyVersion: challenge.policyVersion,
    });
    const baseManifest = await loadBaseManifest({
      url: BASE_MANIFEST_URL,
      userDataDirectory,
      expectedBuildId: challenge.baseBuildId,
    });
    const assetState = await assetSync.readState().catch(() => null);
    const installedAssets = (assetState?.assets ?? []).flatMap((asset) =>
      asset.installedFiles.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })));
    // Files the launcher deliberately replaces or adds: expect its artifacts,
    // not the vanilla hashes, so they stay attested instead of excluded. Keep
    // in sync with ATTESTATION_OVERRIDE_PATHS and the policy publisher's
    // --override flags — a missing entry here flags every honest install.
    const overrides = await readLauncherOverrides([
      { installPath: "steam_api64.dll", bundledPath: resolveBundledShimPath() },
      { installPath: "vivoxsdk_x64.dll", bundledPath: resolveBundledVivoxProxyPath() },
      { installPath: "vivoxsdk_x64_v5.dll", bundledPath: resolveBundledVivoxRuntimePath() },
      ...(clientPatchMode === "patched"
        ? [{ installPath: "dinput8.dll", bundledPath: resolveBundledGameplayPatchPath() }]
        : []),
    ]);

    const measurement = await measureInstallation({
      installationRoot: root,
      userDataDirectory,
      expected: mergeExpectedFiles(baseManifest.files, installedAssets, overrides),
      // Report undeclared .pack2/.dll/.exe dropped into the game tree. Costs
      // one directory walk; the per-file hashing dominates anyway.
      detectUnexpected: true,
      onProgress: (progress) => {
        attestationProgress = progress.phase === "done" ? null : progress;
        void broadcastSnapshot();
      },
    });
    attestationProgress = null;
    if (measurement.deviations.length > 0) {
      console.warn(
        `Integrity attestation found ${measurement.deviations.length} deviation(s); reporting them.`,
      );
    }
    // The fingerprint this launch was asked for (#320 §B): the slots the signed
    // challenge names, or the core five for a server that names none. Read
    // after the challenge, so the answer is to this launch's question.
    const hwid = await collectHwid(challenge.hwidSlots ?? HWID_CORE_SLOTS).catch(() => ({}));
    // Sign with the TPM-backed key when the machine has one; null when it does
    // not, and the launch proceeds without it. The message binds the
    // (single-use) challengeId to the fingerprint exactly as the ticket will
    // carry it (#320 §C): neither can be swapped under the other, and the
    // single-use challenge stops replay. The server decides (behind its own
    // flag) whether a missing proof is acceptable.
    const bindingMessage = tpmBindingMessage(challenge.challengeId, hwid);
    const tpmProof = await collectTpmProof(bindingMessage).catch(() => null);
    // Level-2 anchor (#320 §A): the TPM identity key signs the same message,
    // and the server is told which endorsement key it lives under — a
    // credential activation the first time, one confirming request after.
    // Observe only: a machine without it launches exactly as before.
    const anchor = await collectTpmAnchor(bindingMessage).catch(() => null);
    if (anchor !== null) {
      const enrolment = await enrolTpmAnchor(
        { beginUrl: runtime.tpmEnrolBeginUrl, completeUrl: runtime.tpmEnrolCompleteUrl },
        playerKey,
        launcherVersion,
        anchor,
      ).catch(() => null);
      if (enrolment !== null && enrolment.state !== "activated") {
        console.warn("TPM anchor not activated", enrolment);
      }
    }
    return {
      status: "attested",
      block: buildAttestationResult(challenge, measurement, launcherVersion, tpmProof, anchor?.proof ?? null),
      hwid,
      clientPatchMode,
    };
  } catch (error) {
    attestationProgress = null;
    // A minimum-version rejection is authoritative and must reach the Play
    // handler so it can lock the button and surface the mandatory updater UI.
    if ((error as { code?: string })?.code === "launcher_update_required") {
      throw error;
    }
    // No policy published / attestation unconfigured: it does not apply, and
    // the launch proceeds silently exactly as before enforcement existed.
    if (error instanceof AttestationUnavailableError && error.notApplicable) {
      await applyGameplayPatchMode(
        root,
        resolveBundledGameplayPatchPath(),
        fallbackMode,
      ).catch(() => undefined);
      return { status: "not-applicable", clientPatchMode: fallbackMode };
    }
    // A challenge or manifest we could not obtain, or files we could not read:
    // attestation should have run and did not. Carry the reason so a launch the
    // backend then blocks can say why, instead of blaming the launcher version.
    const reason = error instanceof Error && error.message
      ? error.message.replace(/[.]?\s*$/, ".")
      : "the integrity service could not be reached.";
    console.warn("Integrity attestation could not complete", { message: reason });
    await applyGameplayPatchMode(
      root,
      resolveBundledGameplayPatchPath(),
      fallbackMode,
    ).catch(() => undefined);
    return { status: "unavailable", reason, clientPatchMode: fallbackMode };
  }
}

async function snapshot(): Promise<LauncherSnapshot> {
  const configuredRoot = await installationRoot();
  const runtime = activeRuntime();
  return {
    appVersion: app.getVersion(),
    phase,
    selection: { sourceRoot, destinationRoot, sourceKind, sourceDetected, destinationRecommended },
    installationRoot: configuredRoot,
    updates,
    runtime: {
      serverId: runtime.id,
      environment: runtime.environment,
      label: runtime.label,
      websiteOrigin: runtime.websiteOrigin,
      players: statusOf(runtime.id).players,
      capacity: statusOf(runtime.id).capacity,
      servers: runtimeConfigList().map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        environment: candidate.environment,
        websiteOrigin: candidate.websiteOrigin,
        players: statusOf(candidate.id).players,
        capacity: statusOf(candidate.id).capacity,
      })),
    },
    playerIdentity: identitySummary(),
    launcherUpdate: launcherUpdate.state,
    assetSync: assetSyncSummary(),
    debugSession: diagnostics?.debugState() ?? { enabled: false, status: "idle", fileName: null, error: null },
    integrityCheck: attestationProgress
      ? {
        hashedFiles: attestationProgress.hashedFiles,
        totalFiles: attestationProgress.totalFiles,
        hashedBytes: attestationProgress.hashedBytes,
        totalBytes: attestationProgress.totalBytes,
      }
      : null,
    progress,
    error: lastErrorRaw ? localizeServiceError(lastErrorRaw, currentLocale) : null,
    gamePid,
    updateRequired: updateRequired || hasLauncherUpdate(launcherUpdate.state),
    canPlay:
      phase === "ready"
      && configuredRoot !== null
      && activeKey() !== null
      && !gameLauncher.isRunning()
      && !debugSettingWrite && !diagnosticWorkInProgress()
      // A mandatory update blocks Play until a newer launcher is installed.
      && !updateRequired && !hasLauncherUpdate(launcherUpdate.state),
  };
}

function statusOf(serverId: ServerId): ServerStatus {
  return serverStatus[serverId] ?? UNKNOWN_SERVER_STATUS;
}

function identitySummary(): PlayerIdentitySummary {
  return {
    serverId: selectedServerId,
    role: selectedRole,
    configured: activeKey() !== null,
    keys: Object.fromEntries(LAUNCH_PROFILE_IDS.map((profile) => [
      profile,
      playerKeys[profile] ?? null,
    ])) as Record<LaunchProfileId, string | null>,
  };
}

async function broadcastSnapshot(): Promise<void> {
  // Before the services exist there is no snapshot to build; the renderer's
  // own getSnapshot() call waits for them.
  if (!servicesInitialized) return;
  const value = await snapshot();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.snapshotChanged, value);
  }
}

function ensureTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error("Untrusted IPC sender");
  }
  const senderUrl = event.senderFrame?.url ?? "";
  if (!isTrustedRendererUrl(senderUrl)) throw new Error("Untrusted IPC sender");
}

function isTrustedRendererUrl(candidate: string): boolean {
  try {
    const developmentServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (!app.isPackaged && developmentServerUrl) {
      const developmentOrigin = new URL(developmentServerUrl).origin;
      return new URL(candidate).origin === developmentOrigin;
    }

    const parsed = new URL(candidate);
    if (parsed.protocol !== "file:") return false;
    parsed.hash = "";
    parsed.search = "";
    const expected = resolve(join(app.getAppPath(), "dist", "index.html")).toLocaleLowerCase("en-US");
    const actual = resolve(fileURLToPath(parsed)).toLocaleLowerCase("en-US");
    return actual === expected;
  } catch {
    return false;
  }
}

function trustedHandler<T extends unknown[], R>(
  handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<R> | R,
  options: { waitForServices?: boolean } = {},
): (event: IpcMainInvokeEvent, ...args: T) => Promise<R> {
  return async (event, ...args) => {
    ensureTrustedSender(event);
    // The window opens before initialize() finishes; every handler that reads
    // a store waits for it. Window controls do not, so a launcher stuck in
    // initialize() can still be closed.
    if (options.waitForServices !== false) await servicesReady;
    return handler(event, ...args);
  };
}

function operationError<T = undefined>(error: unknown): OperationResult<T> {
  logOperationError(error);
  lastErrorRaw = rawErrorMessage(error);
  return { ok: false, error: localizeServiceError(lastErrorRaw, currentLocale) };
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.setDebugSessionEnabled, trustedHandler(async (_event, enabled: unknown): Promise<OperationResult<LauncherSnapshot>> => {
    if (typeof enabled !== "boolean") return { ok: false, error: diagnosticCopy().invalid };
    if (debugSettingWrite || assetSyncRunning || diagnosticWorkInProgress() || gameLauncher.isRunning() || phase === "launching" || phase === "running" || phase === "installing") {
      return { ok: false, error: diagnosticCopy().settings };
    }
    debugSettingWrite = true;
    const previous = diagnostics.debugState().enabled;
    try {
      diagnostics.setDebugEnabled(enabled);
      const config = await configStore.load();
      await configStore.save({ ...config, debugSessionEnabled: enabled, diagnosticUploadConsent: 1 });
    } catch {
      diagnostics.setDebugEnabled(previous);
      return { ok: false, error: diagnosticCopy().failed };
    } finally {
      debugSettingWrite = false;
      void broadcastSnapshot();
      if (quitWhenGameExits && !mainWindow && !gameLauncher.isRunning() && !diagnosticWorkInProgress()) app.quit();
    }
    return { ok: true, value: await snapshot() };
  }));
  ipcMain.handle(IPC_CHANNELS.reportCrash, trustedHandler(async (): Promise<OperationResult<{ fileName: string }>> => {
    // Keep the app alive from the click, including the async config read that
    // happens before the controller acquires its own operation lock.
    crashReportRequests++;
    try {
      const exported = await diagnostics.reportCrash(join(app.getPath("downloads"), "ROTK-Rapports"), await diagnosticContext());
      shell.showItemInFolder(exported.path);
      return { ok: true, value: { fileName: exported.fileName } };
    } catch { return { ok: false, error: diagnosticCopy().failed }; }
    finally {
      crashReportRequests--;
      if (quitWhenGameExits && !mainWindow && !gameLauncher.isRunning() && phase !== "launching" && phase !== "running" && !diagnosticWorkInProgress()) app.quit();
    }
  }));
  ipcMain.handle(IPC_CHANNELS.getDiagnosticReports, trustedHandler(async (): Promise<OperationResult<DiagnosticState>> => {
    try { return { ok: true, value: await diagnostics.state() }; }
    catch { return { ok: false, error: diagnosticCopy().failed }; }
  }));
  ipcMain.handle(IPC_CHANNELS.captureDiagnostic, trustedHandler(async (_event, request: unknown) => {
    const input = request as Partial<DiagnosticCaptureRequest> | null;
    if (!input || (input.mode !== "standard" && input.mode !== "full") || !validDiagnosticDescription(input.description)) {
      return { ok: false, error: diagnosticCopy().invalid };
    }
    try { return { ok: true, value: await diagnostics.capture(input as DiagnosticCaptureRequest, await diagnosticContext()) }; }
    catch { return { ok: false, error: diagnosticCopy().failed }; }
  }));
  ipcMain.handle(IPC_CHANNELS.exportDiagnostic, trustedHandler(async (_event, request: unknown): Promise<OperationResult<{ fileName: string }>> => {
    const input = request as Partial<DiagnosticExportRequest> | null;
    if (!input || typeof input.reportId !== "string" || typeof input.includeDumps !== "boolean" || !validDiagnosticDescription(input.description)) {
      return { ok: false, error: diagnosticCopy().invalid };
    }
    try {
      const report = await diagnostics.reports.getReport(input.reportId);
      const filename = `ROTK-report-${report.summary.startedAt.slice(0, 10)}-${report.summary.id.slice(0, 8)}.zip`;
      const dialogOptions: Electron.SaveDialogOptions = { title: diagnosticCopy().save, defaultPath: join(app.getPath("downloads"), filename),
        filters: [{ name: "ZIP", extensions: ["zip"] }], properties: ["createDirectory", "showOverwriteConfirmation"] };
      const destination = mainWindow ? await dialog.showSaveDialog(mainWindow, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
      if (destination.canceled || !destination.filePath) return { ok: false, cancelled: true };
      if (await stat(destination.filePath).then(() => true, () => false)) return { ok: false, error: diagnosticCopy().exists };
      await diagnostics.exportReport(input.reportId, destination.filePath, { includeDumps: input.includeDumps, description: input.description });
      shell.showItemInFolder(destination.filePath);
      return { ok: true, value: { fileName: basename(destination.filePath) } };
    } catch { return { ok: false, error: diagnosticCopy().failed }; }
  }));
  ipcMain.handle(IPC_CHANNELS.openDiagnosticsFolder, trustedHandler(async (): Promise<OperationResult> => {
    try {
      const directory = join(app.getPath("userData"), "diagnostics");
      await mkdir(directory, { recursive: true });
      const error = await shell.openPath(directory);
      return error ? { ok: false, error: diagnosticCopy().failed } : { ok: true };
    } catch { return { ok: false, error: diagnosticCopy().failed }; }
  }));
  ipcMain.handle(IPC_CHANNELS.setDiagnosticCaptureEnabled, trustedHandler(async (_event, enabled: unknown): Promise<OperationResult<DiagnosticState>> => {
    if (typeof enabled !== "boolean") return { ok: false, error: diagnosticCopy().invalid };
    if (gameLauncher.isRunning() || phase === "launching" || phase === "running") return { ok: false, error: diagnosticCopy().settings };
    try {
      const config = await configStore.load();
      diagnostics.setEnabled(enabled);
      try { await configStore.save({ ...config, diagnosticCaptureEnabled: enabled }); }
      catch (error) {
        diagnostics.setEnabled(config.diagnosticCaptureEnabled !== false);
        throw error;
      }
      return { ok: true, value: await diagnostics.state() };
    } catch { return { ok: false, error: diagnosticCopy().failed }; }
  }));
  ipcMain.handle(IPC_CHANNELS.getSnapshot, trustedHandler(async () => snapshot()));
  ipcMain.handle(
    IPC_CHANNELS.setLocale,
    trustedHandler(async (_event, locale: unknown) => {
      if (!isAppLocale(locale)) throw new Error("Unsupported launcher locale");
      currentLocale = locale;
      await broadcastSnapshot();
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.setLaunchProfile,
    trustedHandler(async (
      _event,
      serverId: unknown,
      role: unknown,
    ): Promise<OperationResult<LauncherSnapshot>> => {
      if (isSelectionLocked()) return { ok: false, error: MAIN_COPY[currentLocale].serverLocked };
      if (!isServerId(serverId)) return { ok: false, error: MAIN_COPY[currentLocale].unknownServer };
      if (!isPlayerRole(role)) return { ok: false, error: MAIN_COPY[currentLocale].unknownRole };
      try {
        // Server and role move together: a half-applied selection would launch
        // against one infrastructure with the other one's intent.
        await configStore.setLaunchProfile(serverId, role);
        selectedServerId = serverId;
        selectedRole = role;
        lastErrorRaw = null;
        await broadcastSnapshot();
        return { ok: true, value: await snapshot() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.setPlayerKey,
    trustedHandler(async (
      _event,
      profile: unknown,
      value: unknown,
    ): Promise<OperationResult<PlayerIdentitySummary>> => {
      if (isSelectionLocked()) return { ok: false, error: MAIN_COPY[currentLocale].identityLocked };
      if (!isLaunchProfileId(profile)) return { ok: false, error: MAIN_COPY[currentLocale].unknownRole };
      try {
        const identity = identityFromPlayerKey(value);
        await playerKeyStore.save(profile, identity.playerKey);
        playerKeys = { ...playerKeys, [profile]: identity.playerKey };
        lastErrorRaw = null;
        await broadcastSnapshot();
        return { ok: true, value: identitySummary() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.clearPlayerKey,
    trustedHandler(async (_event, profile: unknown): Promise<OperationResult<PlayerIdentitySummary>> => {
      if (isSelectionLocked()) return { ok: false, error: MAIN_COPY[currentLocale].identityLocked };
      if (!isLaunchProfileId(profile)) return { ok: false, error: MAIN_COPY[currentLocale].unknownRole };
      try {
        await playerKeyStore.clear(profile);
        const { [profile]: _removed, ...remaining } = playerKeys;
        playerKeys = remaining;
        lastErrorRaw = null;
        await broadcastSnapshot();
        return { ok: true, value: identitySummary() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.copyPlayerKey,
    trustedHandler(async (_event, profile: unknown): Promise<OperationResult> => {
      if (!isLaunchProfileId(profile)) return { ok: false, error: MAIN_COPY[currentLocale].unknownRole };
      const playerKey = playerKeys[profile];
      if (!playerKey) return { ok: false, error: MAIN_COPY[currentLocale].keyRequired };
      clipboard.writeText(playerKey);
      return { ok: true };
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.detectSource,
    trustedHandler(async (): Promise<OperationResult<{ sourceRoot: string | null }>> => {
      const copy = MAIN_COPY[currentLocale];
      if (gameLauncher.isRunning() || phase === "launching" || phase === "running") {
        return { ok: false, error: copy.clientInUse };
      }
      if (installAbortController) return { ok: false, error: copy.installationInProgress };
      if (sourceRoot) return { ok: true, value: { sourceRoot } };
      try {
        const located = await locateSteamClient();
        if (!located) return { ok: true, value: { sourceRoot: null } };
        const selectedClient = await classifyClientSource(located);
        sourceRoot = selectedClient.root;
        sourceKind = selectedClient.kind;
        sourceDetected = true;
        destinationRoot = null;
        destinationRecommended = false;
        phase = "source-selected";
        await applyRecommendedDestination();
        lastErrorRaw = null;
        await broadcastSnapshot();
        return { ok: true, value: { sourceRoot } };
      } catch {
        // Discovery is best-effort: any failure simply leaves the manual flow.
        return { ok: true, value: { sourceRoot: null } };
      }
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.selectSource,
    trustedHandler(async (): Promise<OperationResult<{ sourceRoot: string }>> => {
      const copy = MAIN_COPY[currentLocale];
      if (gameLauncher.isRunning() || phase === "launching" || phase === "running") {
        return { ok: false, error: copy.clientInUse };
      }
      if (!mainWindow) return { ok: false, error: copy.windowUnavailable };
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: copy.sourceDialog.title,
        message: copy.sourceDialog.message,
        buttonLabel: copy.sourceDialog.button,
        properties: ["openDirectory"],
      });
      if (selected.canceled || selected.filePaths.length === 0) return { ok: false, cancelled: true };
      try {
        const selectedClient = await classifyClientSource(selected.filePaths[0]);
        sourceRoot = selectedClient.root;
        sourceKind = selectedClient.kind;
        sourceDetected = false;
        destinationRoot = null;
        destinationRecommended = false;
        phase = "source-selected";
        await applyRecommendedDestination();
        lastErrorRaw = null;
        await broadcastSnapshot();
        return { ok: true, value: { sourceRoot } };
      } catch (error) {
        const result = operationError<{ sourceRoot: string }>(error);
        phase = "error";
        await broadcastSnapshot();
        return result;
      }
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.selectDestination,
    trustedHandler(async (): Promise<OperationResult<{ destinationRoot: string }>> => {
      const copy = MAIN_COPY[currentLocale];
      if (!sourceRoot) return { ok: false, error: copy.selectSourceFirst };
      if (sourceKind !== "copy-required") return { ok: false, error: copy.destinationNotNeeded };
      if (!mainWindow) return { ok: false, error: copy.windowUnavailable };
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: copy.destinationDialog.title,
        message: copy.destinationDialog.message(ROTK_INSTALL_DIRECTORY_NAME),
        buttonLabel: copy.destinationDialog.button,
        properties: ["openDirectory", "createDirectory"],
      });
      if (selected.canceled || selected.filePaths.length === 0) return { ok: false, cancelled: true };
      try {
        const parent = selected.filePaths[0];
        const candidate = basename(parent).toLocaleLowerCase("en-US") === ROTK_INSTALL_DIRECTORY_NAME.toLocaleLowerCase("en-US")
          ? parent
          : join(parent, ROTK_INSTALL_DIRECTORY_NAME);
        destinationRoot = await validateInstallDestination(candidate, sourceRoot);
        destinationRecommended = false;
        phase = "destination-selected";
        lastErrorRaw = null;
        await broadcastSnapshot();
        return { ok: true, value: { destinationRoot } };
      } catch (error) {
        const result = operationError<{ destinationRoot: string }>(error);
        phase = "error";
        await broadcastSnapshot();
        return result;
      }
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dismissError,
    trustedHandler(async () => {
      lastErrorRaw = null;
      await broadcastSnapshot();
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.install,
    trustedHandler(async (): Promise<OperationResult<{ installationRoot: string }>> => {
      const copy = MAIN_COPY[currentLocale];
      if (!sourceRoot || !sourceKind) return { ok: false, error: copy.selectSourceFirst };
      if (sourceKind === "copy-required" && !destinationRoot) return { ok: false, error: copy.selectBoth };
      if (gameLauncher.isRunning() || phase === "launching" || phase === "running") {
        return { ok: false, error: copy.clientInUse };
      }
      if (installAbortController) return { ok: false, error: MAIN_COPY[currentLocale].installationInProgress };
      installAbortController = new AbortController();
      phase = "installing";
      progress = null;
      lastErrorRaw = null;
      await broadcastSnapshot();
      try {
        const onProgress = (nextProgress: NonNullable<LauncherSnapshot["progress"]>): void => {
          progress = nextProgress;
          void broadcastSnapshot();
        };
        const installationRoot = sourceKind === "direct"
          ? sourceRoot
          : destinationRoot as string;
        const marker = sourceKind === "direct"
          ? await adoptExistingClient({
              root: sourceRoot,
              shimPath: resolveBundledShimPath(),
              vivoxProxyPath: resolveBundledVivoxProxyPath(),
              vivoxRuntimePath: resolveBundledVivoxRuntimePath(),
              launcherVersion: app.getVersion(),
              onProgress,
            })
          : await installClient({
              sourceRoot,
              destinationRoot: installationRoot,
              shimPath: resolveBundledShimPath(),
              vivoxProxyPath: resolveBundledVivoxProxyPath(),
              vivoxRuntimePath: resolveBundledVivoxRuntimePath(),
              launcherVersion: app.getVersion(),
              signal: installAbortController.signal,
              onProgress,
            });
        await configStore.setInstallation({
          installId: marker.installId,
          clientBuildId: marker.clientBuildId,
          root: installationRoot,
          sourceRoot,
          installedAt: marker.installedAt,
          criticalHashes: marker.criticalHashes,
        });
        phase = "ready";
        progress = null;
        await broadcastSnapshot();
        // Best-effort first asset sync: a feed problem surfaces in the asset
        // summary without turning the completed installation into a failure.
        await runAssetSync("sync", true);
        return { ok: true, value: { installationRoot } };
      } catch (error) {
        const cancelled = installAbortController.signal.aborted;
        const result = operationError<{ installationRoot: string }>(error);
        result.cancelled = cancelled;
        phase = "error";
        progress = null;
        await broadcastSnapshot();
        return result;
      } finally {
        installAbortController = null;
      }
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.cancelInstall,
    trustedHandler(async () => {
      installAbortController?.abort(new DOMException("Installation cancelled", "AbortError"));
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.play,
    trustedHandler(async (): Promise<OperationResult<{ pid: number }>> => {
      if (updateRequired || hasLauncherUpdate(launcherUpdate.state)) {
        return { ok: false, error: MAIN_COPY[currentLocale].update.required };
      }
      if (phase !== "ready" || debugSettingWrite || diagnosticWorkInProgress()) return { ok: false, error: MAIN_COPY[currentLocale].clientNotReady };
      const selectedKey = activeKey();
      if (!selectedKey) {
        return {
          ok: false,
          error: selectedRole === "admin"
            ? MAIN_COPY[currentLocale].adminKeyRequired
            : MAIN_COPY[currentLocale].keyRequired,
        };
      }
      // Freeze the whole launch contract now: a server switch mid-launch must
      // never send this credential to the other infrastructure.
      const launchCredential = identityFromPlayerKey(selectedKey);
      const launchRuntime = activeRuntime();
      phase = "launching";
      lastErrorRaw = null;
      await broadcastSnapshot();
      // A discovered update must be fully downloaded and installed before
      // starting the game; launching with a partially updated asset set is unsafe.
      const assetResult = await runAssetSync("sync", false);
      if (!assetResult.ok) {
        phase = "ready";
        await broadcastSnapshot();
        return { ok: false, error: assetResult.error };
      }
      let diagnosticLaunch: Awaited<ReturnType<DiagnosticController["beginLaunch"]>> | undefined;
      try {
        try { diagnosticLaunch = await diagnostics.beginLaunch(await diagnosticContext(launchRuntime)); }
        catch { /* A report directory failure cannot block an otherwise valid game launch. */ }
        const pid = await gameLauncher.launch({
          config: await configStore.load(),
          identity: launchCredential,
          runtime: launchRuntime,
          logsRoot: join(app.getPath("userData"), "logs"),
          bundledShimPath: resolveBundledShimPath(),
          bundledVivoxProxyPath: resolveBundledVivoxProxyPath(),
          bundledVivoxRuntimePath: resolveBundledVivoxRuntimePath(),
          bundledGameplayPatchPath: resolveBundledGameplayPatchPath(),
          clientPatchModeFallback:
            await readCachedGameplayPatchMode(join(app.getPath("userData"))) ?? "patched",
          attest: () => attestInstallation(launchCredential.playerKey, launchRuntime),
          launcherVersion: app.getVersion(),
          diagnostics: diagnosticLaunch?.hooks,
          // Best-effort hardware fingerprint; the server hashes it. A failure
          // must never block a launch, so it degrades to no HWID signal.
          hwid: await collectHwid().catch(() => ({})),
          onExit: () => {
            gamePid = null;
            phase = "ready";
            void broadcastSnapshot();
            if (quitWhenGameExits && !mainWindow && !diagnosticWorkInProgress()) app.quit();
          },
        });
        gamePid = pid;
        phase = "running";
        await broadcastSnapshot();
        return { ok: true, value: { pid } };
      } catch (error) {
        if (diagnosticLaunch) await diagnostics.launchFailed(diagnosticLaunch.id, error).catch(() => undefined);
        const result = operationError<{ pid: number }>(error);
        // A version refusal makes the update mandatory: block Play, and CHECK
        // for the update (metadata only — autoDownload is false) so the modal
        // can show that a new version exists. Nothing is downloaded here; the
        // installer is fetched only when the player consents via the update
        // action. Any other failure stays retryable, so it must not set the flag.
        if ((error as { code?: string })?.code === "launcher_update_required") {
          updateRequired = true;
          void launcherUpdate.check().catch(() => undefined);
        }
        phase = "ready";
        await broadcastSnapshot();
        if (quitWhenGameExits && !mainWindow && !diagnosticWorkInProgress()) app.quit();
        return result;
      }
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.openWebsite,
    trustedHandler(async (_event, path: string, serverId?: unknown): Promise<OperationResult> => {
      try {
        if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
          throw new Error(MAIN_COPY[currentLocale].unauthorizedLink);
        }
        // The account page that issues a key belongs to that key's server, so
        // the caller names it. Unnamed means the selected one, and an unknown
        // identifier resolves through the registry — never to a free-form host.
        const websiteOrigin = serverId === undefined
          ? activeRuntime().websiteOrigin
          : runtimeConfigFor(serverId).websiteOrigin;
        const target = new URL(path, websiteOrigin);
        if (target.origin !== websiteOrigin) throw new Error(MAIN_COPY[currentLocale].unauthorizedLink);
        await shell.openExternal(target.href);
        return { ok: true };
      } catch (error) {
        return operationError(error);
      }
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.checkLauncherUpdate,
    trustedHandler(async () => launcherUpdate.check()),
  );

  ipcMain.handle(
    IPC_CHANNELS.downloadLauncherUpdate,
    trustedHandler(async (): Promise<OperationResult> => {
      const failure = launcherUpdate.download();
      if (!failure) return { ok: true };
      return { ok: false, error: MAIN_COPY[currentLocale].update[failure] };
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.installLauncherUpdate,
    trustedHandler(async (): Promise<OperationResult> => {
      if (gameLauncher.isRunning() || phase === "launching" || phase === "running") {
        return { ok: false, error: MAIN_COPY[currentLocale].update.gameRunning };
      }
      const failure = launcherUpdate.install();
      if (!failure) return { ok: true };
      return { ok: false, error: MAIN_COPY[currentLocale].update[failure] };
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.verifyAssets,
    trustedHandler(async (): Promise<OperationResult> => {
      const copy = MAIN_COPY[currentLocale];
      if (gameLauncher.isRunning() || phase === "launching" || phase === "running") {
        return { ok: false, error: copy.clientInUse };
      }
      if (phase === "installing") return { ok: false, error: copy.installationInProgress };
      if (!assetSyncEnabled) return { ok: false, error: copy.assets.disabled };
      return runAssetSync("verify", false);
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.restoreVanillaAssets,
    trustedHandler(async (): Promise<OperationResult> => {
      const copy = MAIN_COPY[currentLocale];
      if (gameLauncher.isRunning() || phase === "launching" || phase === "running") {
        return { ok: false, error: copy.clientInUse };
      }
      if (phase === "installing") return { ok: false, error: copy.installationInProgress };
      if (assetSyncRunning) return { ok: false, error: copy.assets.busy };
      const root = await installationRoot();
      if (!root) return { ok: false, error: copy.clientNotReady };
      try {
        await assetSync.restore(root);
        assetSyncStatus = "idle";
        assetSyncWarning = null;
        assetSyncPackVersion = null;
        assetSyncLastAt = null;
        lastErrorRaw = null;
        await broadcastSnapshot();
        return { ok: true };
      } catch (error) {
        const result = operationError(error);
        await broadcastSnapshot();
        return result;
      }
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.setAssetSyncEnabled,
    trustedHandler(async (_event, enabled: unknown): Promise<OperationResult> => {
      if (typeof enabled !== "boolean") throw new Error("Unsupported asset sync setting");
      if (assetSyncRunning) return { ok: false, error: MAIN_COPY[currentLocale].assets.busy };
      await configStore.setAssetSyncEnabled(enabled);
      assetSyncEnabled = enabled;
      assetSyncStatus = enabled ? "idle" : "disabled";
      assetSyncWarning = null;
      await broadcastSnapshot();
      return { ok: true };
    }),
  );

  ipcMain.handle(IPC_CHANNELS.minimizeWindow, trustedHandler(async () => mainWindow?.minimize(), { waitForServices: false }));
  ipcMain.handle(IPC_CHANNELS.closeWindow, trustedHandler(async () => mainWindow?.close(), { waitForServices: false }));
}

function createWindow(): BrowserWindow {
  const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
  const window = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: "#090909",
    title: "ROTK Launcher",
    icon: join(app.getAppPath(), app.isPackaged ? "dist" : "public", "branding", "rotk-mark.png"),
    webPreferences: {
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // loadFile() is the only initial navigation and its target is constructed by
  // the main process below. Register the deny-all guard after that navigation
  // completes: doing it earlier can reject Electron's app.asar file URL before
  // the renderer is available. External ROTK links always go through the
  // allowlisted openWebsite IPC channel.
  window.webContents.once("did-finish-load", () => {
    window.webContents.on("will-navigate", (event) => event.preventDefault());
  });
  // Shown on the first of: the renderer's first paint, its load completing, or
  // a deadline. Before 2.0.15 only ready-to-show showed the window, so a
  // renderer that never painted left a live process and no window at all.
  let shown = false;
  const showOnce = (source: string): void => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    window.show();
    startupLog.mark("window-shown", source);
  };
  window.once("ready-to-show", () => showOnce("ready-to-show"));
  window.webContents.once("did-finish-load", () => showOnce("did-finish-load"));
  const showDeadline = setTimeout(() => showOnce("deadline"), WINDOW_SHOW_DEADLINE_MS);
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    // -3 (ABORTED) is a navigation replaced by another, not a failed page.
    if (!isMainFrame || errorCode === -3) return;
    startupLog.mark("did-fail-load", `${errorCode} ${errorDescription}`);
    showOnce("did-fail-load");
  });
  // A renderer that cannot start (2.0.14: "Renderer process launch-failed") or
  // crashes leaves a window with nothing in it. Say so once and leave the
  // decision to the player: quitting here would take a running game's launcher
  // away with it.
  let rendererFailureReported = false;
  window.webContents.on("render-process-gone", (_event, details) => {
    startupLog.mark("render-process-gone", `${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === "clean-exit" || rendererFailureReported) return;
    rendererFailureReported = true;
    void diagnostics?.recordLauncherError("launcher_renderer_gone", new Error(details.reason)).catch(() => undefined);
    const copy = MAIN_COPY[currentLocale];
    dialog.showErrorBox(copy.startupTitle, `${copy.rendererGone(details.reason)}\n\n${copy.startupSafety}`);
  });
  window.on("closed", () => {
    clearTimeout(showDeadline);
    if (mainWindow === window) mainWindow = null;
  });
  Menu.setApplicationMenu(null);

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer && !app.isPackaged) void window.loadURL(devServer);
  else void window.loadFile(join(app.getAppPath(), "dist", "index.html"));
  return window;
}

async function initialize(): Promise<void> {
  startupLog.mark("ready");
  // The window comes first: a step below that stalls (a sleeping drive under
  // the installation root, a slow profile) still leaves a launcher on screen,
  // and a renderer or GPU child that cannot start is seen and logged rather
  // than leaving a process without a window. The handlers registered here
  // wait for the services through servicesReady.
  registerIpc();
  mainWindow = createWindow();
  startupLog.mark("window-created");
  configStore = new ConfigStore(
    app.getPath("userData"),
    legacyUserDataDirectories,
    async (installation) => {
      try {
        await validateInstalledClient(installation);
        return true;
      } catch {
        return false;
      }
    },
  );
  playerKeyStore = new PlayerKeyStore(
    join(app.getPath("userData"), "player-keys.v2.json"),
    {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    },
    join(app.getPath("userData"), "player-key.v1.json"),
  );
  playerKeys = await playerKeyStore.load();
  startupLog.mark("player-keys-loaded");
  updateFeed = new UpdateFeedService(app.getPath("userData"));
  assetSync = new AssetSyncService({
    userDataDirectory: app.getPath("userData"),
    onProgress: (value) => {
      assetSyncStatus = value.phase === "checking"
        ? "checking"
        : value.phase === "downloading" ? "downloading" : "installing";
      assetSyncProgress = value;
      void broadcastSnapshot();
    },
  });
  const config = await configStore.load();
  startupLog.mark("config-loaded");
  assetSyncEnabled = config.assetSyncEnabled ?? true;
  selectedServerId = config.serverId ?? DEFAULT_SERVER_ID;
  selectedRole = config.role ?? DEFAULT_PLAYER_ROLE;
  const assetState = await assetSync.readState().catch(() => null);
  assetSyncPackVersion = assetState?.packVersion ?? null;
  assetSyncLastAt = assetState?.syncedAt ?? null;
  if (config.installation) {
    try {
      await validateInstalledClient(config.installation);
      phase = "ready";
    } catch (error) {
      phase = "error";
      lastErrorRaw = rawErrorMessage(error);
    }
  }
  startupLog.mark("installation-checked", `phase=${phase}`);
  launcherUpdate = new LauncherUpdateService({
    // In development there is no installed package to update against;
    // the updater stays inert and the snapshot reports "idle".
    updater: app.isPackaged ? electronUpdater.autoUpdater : null,
    onChange: () => void broadcastSnapshot(),
  });
  diagnostics = new DiagnosticController({ directory: join(app.getPath("userData"), "diagnostics"),
    helperPath: resolveBundledDiagnosticsPath(), knownSecrets: () => Object.values(playerKeys).filter((key): key is string => typeof key === "string"),
    frameTimesPath: join(dirname(resolveBundledDiagnosticsPath()), "PresentMon.exe"),
    uploadSession: async (id, context) => {
      if (!isServerId(context.serverId) || !isPlayerRole(context.role)) throw new Error('Invalid diagnostic profile');
      const key = playerKeys[launchProfileId(context.serverId, context.role)];
      if (!key || createHash('sha256').update(key).digest('hex') !== context.diagnosticCredentialHash) throw new Error('Diagnostic account changed');
      return uploadDiagnostic(await diagnostics.reports.prepareUpload(id), runtimeConfigFor(context.serverId).websiteOrigin, key);
    },
    collectClientContext: async (context) => collectDiagnosticClientContext({ installationRoot: context.installationRoot,
      assetSyncEnabled: context.assetSyncEnabled === true, assetPackVersion: context.assetPackVersion,
      assetState: await assetSync.readState().catch(() => null) }),
    onDebugChange: () => { void broadcastSnapshot(); },
    onChange: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.diagnosticsChanged, state);
    } });
  await diagnostics.initialize(config.diagnosticCaptureEnabled ?? true, config.diagnosticUploadConsent === 1 && config.debugSessionEnabled === true).catch(() => undefined);
  servicesInitialized = true;
  resolveServicesReady();
  startupLog.mark("services-ready");
  updates = await updateFeed.getLatest();
  await broadcastSnapshot();
  void launcherUpdate.check();
  setInterval(() => void launcherUpdate.check(), LAUNCHER_UPDATE_CHECK_INTERVAL_MS);
  void refreshServerStatus();
  setInterval(() => void refreshServerStatus(), SERVER_STATUS_POLL_INTERVAL_MS);
}

if (singleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) {
      // Still starting: the window is on its way.
      if (!servicesInitialized) return;
      // The window was closed while the game ran (window-all-closed keeps the
      // process alive for it): give it back instead of ignoring the click.
      quitWhenGameExits = false;
      mainWindow = createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // GPU, utility and renderer children that end abnormally, with the reason
  // Chromium gives (2.0.14: GPU "launch-failed" six times, then the abort).
  app.on("child-process-gone", (_event, details) => {
    startupLog.mark(
      "child-process-gone",
      `${details.type} ${details.reason} exitCode=${details.exitCode}${details.name ? ` name=${details.name}` : ""}`,
    );
  });

  void app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
      await initialize();
    })
    .catch((error: unknown) => {
      startupLog.mark("startup-failed", errorMessage(error));
      const copy = MAIN_COPY[currentLocale];
      dialog.showErrorBox(
        copy.startupTitle,
        `${errorMessage(error)}\n\n${copy.startupSafety}`,
      );
      app.quit();
    });

  app.on("window-all-closed", () => {
    if (gameLauncher.isRunning() || phase === "launching" || phase === "running" || diagnosticWorkInProgress()) {
      quitWhenGameExits = true;
      return;
    }
    app.quit();
  });
}

process.on("uncaughtException", (error) => {
  startupLog.mark("uncaught-exception", error.message);
  void diagnostics?.recordLauncherError("launcher_uncaught_exception", error).catch(() => undefined);
  lastErrorRaw = `Erreur launcher ${randomUUID().slice(0, 8)} : ${error.message}`;
  phase = "error";
  void broadcastSnapshot();
});

process.on("unhandledRejection", (error) => {
  void diagnostics?.recordLauncherError("launcher_unhandled_rejection", error).catch(() => undefined);
});
