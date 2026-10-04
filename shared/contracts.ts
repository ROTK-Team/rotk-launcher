export type LauncherPhase =
  | "unconfigured"
  | "source-selected"
  | "destination-selected"
  | "installing"
  | "ready"
  | "launching"
  | "running"
  | "error";

export interface PublishedUpdate {
  id: string;
  type: "dev" | "patch";
  title: string;
  summary: string;
  version: string | null;
  category: string;
  coverImageUrl: string;
  publishedAt: string;
  siteUrl: string;
}

export interface InstallProgress {
  phase: "scanning" | "copying" | "verifying" | "configuring" | "finalizing";
  completedBytes: number;
  totalBytes: number;
  filesCompleted: number;
  totalFiles: number;
  currentFile: string;
}

export interface InstallDrive {
  /** Drive root, e.g. `D:\`. */
  root: string;
  freeBytes: number;
  totalBytes: number;
}

export interface InstallSelection {
  sourceRoot: string | null;
  destinationRoot: string | null;
  sourceKind: ClientSourceKind | null;
  /** The source was found by automatic Steam discovery, not a manual pick. */
  sourceDetected: boolean;
  /** The destination is the launcher-suggested default, not a manual pick. */
  destinationRecommended: boolean;
}

export type ClientSourceKind = "direct" | "copy-required";

export type AssetSyncStatus =
  | "idle"
  | "disabled"
  | "checking"
  | "downloading"
  | "installing"
  | "up-to-date"
  | "warning"
  | "error";

/** Localizable warning identifiers so the renderer picks the wording. */
export type AssetSyncWarning = "feed-unavailable" | "sync-failed";

export interface AssetSyncProgress {
  phase: "checking" | "downloading" | "installing";
  assetName: string;
  assetsCompleted: number;
  totalAssets: number;
  completedBytes: number;
  totalBytes: number;
}

export interface AssetSyncSummary {
  enabled: boolean;
  status: AssetSyncStatus;
  /** Pack version of the last completed sync, if any. */
  packVersion: string | null;
  lastSyncAt: string | null;
  progress: AssetSyncProgress | null;
  warning: AssetSyncWarning | null;
}

export interface ServerOption {
  id: ServerId;
  label: string;
  environment: "development" | "production";
  websiteOrigin: string;
  /** Live population. Null players means the server could not be reached. */
  players: number | null;
  capacity: number | null;
}

export interface RuntimeSummary {
  /** Server the next launch targets. */
  serverId: ServerId;
  environment: "development" | "production";
  label: string;
  websiteOrigin: string;
  /** Live population of the selected server; null while unknown. */
  players: number | null;
  capacity: number | null;
  /** Every selectable server, so the renderer never invents an identifier. */
  servers: ServerOption[];
}

export interface PlayerIdentitySummary {
  serverId: ServerId;
  /** Role the next launch runs under. */
  role: PlayerRole;
  /** A key is stored for the active server and role. */
  configured: boolean;
  /** Every server/role slot. Null when the slot holds no key yet. */
  keys: Record<LaunchProfileId, string | null>;
}

export type LauncherUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface LauncherUpdateSummary {
  status: LauncherUpdateStatus;
  availableVersion: string | null;
  progressPercent: number | null;
  error: string | null;
}

/**
 * Progress of the pre-launch integrity check. Null when idle; hashing the whole
 * installation takes minutes on a first run and seconds afterwards (cached).
 */
export interface IntegrityCheckSummary {
  hashedFiles: number;
  totalFiles: number;
  hashedBytes: number;
  totalBytes: number;
}

export interface LauncherSnapshot {
  debugSession?: DebugSessionSummary;
  appVersion: string;
  phase: LauncherPhase;
  selection: InstallSelection;
  installationRoot: string | null;
  updates: PublishedUpdate[];
  runtime: RuntimeSummary;
  playerIdentity: PlayerIdentitySummary;
  launcherUpdate: LauncherUpdateSummary;
  assetSync: AssetSyncSummary;
  integrityCheck: IntegrityCheckSummary | null;
  progress: InstallProgress | null;
  error: string | null;
  gamePid: number | null;
  /** The server refused a launch for an out-of-date launcher; Play is blocked
   *  until a newer version is installed. */
  updateRequired: boolean;
  canPlay: boolean;
}

export interface DebugSessionSummary {
  enabled: boolean;
  status: "idle" | "recording" | "preparing" | "ready" | "error";
  fileName: string | null;
  error: string | null;
}

export interface OperationResult<T = undefined> {
  ok: boolean;
  value?: T;
  error?: string;
  cancelled?: boolean;
}

export interface RotkLauncherApi {
  setDebugSessionEnabled(enabled: boolean): Promise<OperationResult<LauncherSnapshot>>;
  getDiagnosticReports(): Promise<OperationResult<import("./diagnostics.js").DiagnosticState>>;
  reportCrash(): Promise<OperationResult<{ fileName: string }>>;
  captureDiagnostic(request: import("./diagnostics.js").DiagnosticCaptureRequest): Promise<OperationResult<import("./diagnostics.js").DiagnosticReportSummary>>;
  exportDiagnostic(request: import("./diagnostics.js").DiagnosticExportRequest): Promise<OperationResult<{ fileName: string }>>;
  openDiagnosticsFolder(): Promise<OperationResult>;
  setDiagnosticCaptureEnabled(enabled: boolean): Promise<OperationResult<import("./diagnostics.js").DiagnosticState>>;
  onDiagnosticsChanged(listener: (state: import("./diagnostics.js").DiagnosticState) => void): () => void;
  getSnapshot(): Promise<LauncherSnapshot>;
  setLocale(locale: AppLocale): Promise<void>;
  /** Selects the server and the role a launch runs under, in one operation. */
  setLaunchProfile(serverId: ServerId, role: PlayerRole): Promise<OperationResult<LauncherSnapshot>>;
  setPlayerKey(profile: LaunchProfileId, playerKey: string): Promise<OperationResult<PlayerIdentitySummary>>;
  clearPlayerKey(profile: LaunchProfileId): Promise<OperationResult<PlayerIdentitySummary>>;
  copyPlayerKey(profile: LaunchProfileId): Promise<OperationResult>;
  detectSource(): Promise<OperationResult<{ sourceRoot: string | null }>>;
  selectSource(): Promise<OperationResult<{ sourceRoot: string }>>;
  selectDestination(): Promise<OperationResult<{ destinationRoot: string }>>;
  listInstallDrives(): Promise<InstallDrive[]>;
  /** Installs into `<drive>\Games\ROTK`. */
  chooseInstallDrive(root: string): Promise<OperationResult<{ destinationRoot: string }>>;
  install(): Promise<OperationResult<{ installationRoot: string }>>;
  cancelInstall(): Promise<void>;
  play(): Promise<OperationResult<{ pid: number }>>;
  /** Opens a ROTK site path; `serverId` picks which site, defaulting to the selected one. */
  openWebsite(path: string, serverId?: ServerId): Promise<OperationResult>;
  checkLauncherUpdate(): Promise<void>;
  downloadLauncherUpdate(): Promise<OperationResult>;
  installLauncherUpdate(): Promise<OperationResult>;
  verifyAssets(): Promise<OperationResult>;
  restoreVanillaAssets(): Promise<OperationResult>;
  setAssetSyncEnabled(enabled: boolean): Promise<OperationResult>;
  minimizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  onSnapshot(listener: (snapshot: LauncherSnapshot) => void): () => void;
}

export const IPC_CHANNELS = {
  setDebugSessionEnabled: "diagnostics:set-debug-session-enabled",
  getDiagnosticReports: "diagnostics:list",
  reportCrash: "diagnostics:report-crash",
  captureDiagnostic: "diagnostics:capture",
  exportDiagnostic: "diagnostics:export",
  openDiagnosticsFolder: "diagnostics:open-folder",
  setDiagnosticCaptureEnabled: "diagnostics:set-capture-enabled",
  diagnosticsChanged: "diagnostics:changed",
  getSnapshot: "launcher:get-snapshot",
  setLocale: "launcher:set-locale",
  setLaunchProfile: "launcher:set-launch-profile",
  setPlayerKey: "launcher:set-player-key",
  clearPlayerKey: "launcher:clear-player-key",
  copyPlayerKey: "launcher:copy-player-key",
  detectSource: "launcher:detect-source",
  selectSource: "launcher:select-source",
  selectDestination: "launcher:select-destination",
  listInstallDrives: "launcher:list-install-drives",
  chooseInstallDrive: "launcher:choose-install-drive",
  install: "launcher:install",
  cancelInstall: "launcher:cancel-install",
  play: "launcher:play",
  openWebsite: "launcher:open-website",
  checkLauncherUpdate: "launcher:update-check",
  downloadLauncherUpdate: "launcher:update-download",
  installLauncherUpdate: "launcher:update-install",
  verifyAssets: "asset-sync:verify",
  restoreVanillaAssets: "asset-sync:restore",
  setAssetSyncEnabled: "asset-sync:set-enabled",
  minimizeWindow: "window:minimize",
  closeWindow: "window:close",
  snapshotChanged: "launcher:snapshot-changed",
} as const;
import type { AppLocale } from "./locale.js";
import type { LaunchProfileId, PlayerRole, ServerId } from "./launch-profile.js";
