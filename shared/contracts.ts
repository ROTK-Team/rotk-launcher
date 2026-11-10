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

/** A competition of the ROTK site that a player can join or watch right now. */
export interface LauncherEvent {
  id: string;
  name: string;
  /** Who runs it. */
  host: string;
  mode: string;
  region: string;
  phase: "running" | "applications" | "roster";
  startsAt: string | null;
  applicationsCloseAt: string | null;
  /** Path of its page on the ROTK site. */
  sitePath: string;
}

/**
 * What the site's staff chose for the line of the home page: a message of
 * their own, the latest publication, the competitions, or nothing. "auto"
 * shows the competitions when there are some.
 */
export interface LauncherBanner {
  /** The staff's switch: off hides the line and keeps what was chosen for it. */
  enabled: boolean;
  mode: "auto" | "message" | "news" | "event" | "off";
  /** The staff's messages, shown one after the other. */
  messages: BannerMessage[];
  /** One competition to show rather than all the live ones. */
  eventKey: string | null;
}

export interface BannerMessage {
  /** The staff's text by language, empty when not written; the window falls back to English. */
  text: Record<AppLocale, string>;
  /** Path on the ROTK site the message leads to. */
  link: string | null;
}

/** A card the site's staff shows before the publications on the home page: a temporary event. */
export interface FeaturedCard {
  id: string;
  /** By language, empty when not written; the window falls back to English. */
  label: Record<AppLocale, string>;
  title: Record<AppLocale, string>;
  summary: Record<AppLocale, string>;
  /** An image of the ROTK site, or empty. */
  imageUrl: string;
  /** An image of the ROTK site for the back of the page while this card is the one shown, or empty. */
  backgroundUrl: string;
  /** Path on the ROTK site the card leads to. */
  link: string | null;
  /** When the card stops being shown. */
  endsAt: string | null;
}

/** Images the site's staff chose for the back of the home page. */
export interface HomeBackgrounds {
  /** Images of the ROTK site, in the staff's order; none keeps the launcher's own art. */
  images: string[];
  /** Seconds each image stays when they rotate; null shows the first one only. */
  rotateSeconds: number | null;
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
  /** Network speed while downloading, once measured. */
  bytesPerSecond?: number;
  /** Time the remaining bytes take at that speed, once it is steady. */
  secondsLeft?: number;
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

/** An interface font the player may pick (resources/fonts/manifest.json). */
export interface PlayerFontOption {
  id: string;
  name: string;
  /** False when the font has no Cyrillic letters (Russian text falls back). */
  cyrillic: boolean;
}

export interface PlayerFontSummary {
  /** Font of the in-game interface, installed before each launch. */
  selected: string;
  /** Font of the launcher itself, applied at once. */
  launcherSelected: string;
  options: PlayerFontOption[];
}

/** The font files of one choice for the launcher: preview titles, buttons, text, plus a bold. */
export interface PlayerFontPreview {
  id: string;
  title: Uint8Array;
  button: Uint8Array;
  body: Uint8Array;
  bold: Uint8Array;
  /** Capital H height over the em of the text font, to draw it at the launcher's size. */
  capHeight: number;
}

export interface LauncherSnapshot {
  debugSession?: DebugSessionSummary;
  appVersion: string;
  phase: LauncherPhase;
  selection: InstallSelection;
  installationRoot: string | null;
  updates: PublishedUpdate[];
  events: LauncherEvent[];
  /** Null when the site gave no choice: the home page then decides as "auto". */
  banner: LauncherBanner | null;
  featured: FeaturedCard[];
  backgrounds: HomeBackgrounds;
  runtime: RuntimeSummary;
  playerIdentity: PlayerIdentitySummary;
  launcherUpdate: LauncherUpdateSummary;
  /** The player's setting: download a launcher update as soon as it is found. */
  launcherUpdateAutoDownload: boolean;
  preferences: LauncherPreferences;
  assetSync: AssetSyncSummary;
  playerFont: PlayerFontSummary;
  integrityCheck: IntegrityCheckSummary | null;
  progress: InstallProgress | null;
  error: string | null;
  /** Something the launcher repaired on its own that the player should know. */
  notice: string | null;
  gamePid: number | null;
  /** The selected H1Z1's exe is a build ROTK does not support: the setup adds
   *  a patch step with the Steam console command that downloads the supported
   *  one, done once Steam has downloaded it. Null when no patch is needed. */
  steamExecutable?: { command: string; downloaded: boolean } | null;
  /** The server refused a launch for an out-of-date launcher; Play is blocked
   *  until a newer version is installed. */
  updateRequired: boolean;
  canPlay: boolean;
}

/** Why a Debug report was not sent. Stable codes, shown to the player. */
export type DebugReportFailureReason =
  | "collection"
  | "timeout"
  | "network"
  | "rejected"
  | "account-changed"
  | "other";

export interface DebugSessionSummary {
  enabled: boolean;
  status: "idle" | "recording" | "preparing" | "ready" | "error";
  fileName: string | null;
  error: string | null;
  /** Set with the "error" status. httpStatus when the ROTK server answered. */
  failure?: { reason: DebugReportFailureReason; httpStatus: number | null } | null;
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
  /** Opens Steam on the H1Z1 install page. */
  openSteamInstall(): Promise<OperationResult>;
  /** Copies the download_depot command and opens the Steam console. */
  openSteamConsole(): Promise<OperationResult>;
  dismissError(): Promise<void>;
  listInstallDrives(): Promise<InstallDrive[]>;
  /** Installs into `<drive>\Games\ROTK`. */
  chooseInstallDrive(root: string): Promise<OperationResult<{ destinationRoot: string }>>;
  install(): Promise<OperationResult<{ installationRoot: string }>>;
  cancelInstall(): Promise<void>;
  play(): Promise<OperationResult<{ pid: number }>>;
  /** Ends a running H1Z1 after the player confirms it. */
  stopGame(): Promise<OperationResult>;
  /** Opens a ROTK site path; `serverId` picks which site, defaulting to the selected one. */
  openWebsite(path: string, serverId?: ServerId): Promise<OperationResult>;
  checkLauncherUpdate(): Promise<void>;
  downloadLauncherUpdate(): Promise<OperationResult>;
  installLauncherUpdate(): Promise<OperationResult>;
  setLauncherUpdateAutoDownload(enabled: boolean): Promise<OperationResult>;
  /** Changes the given preferences; the others keep their value. */
  setPreferences(preferences: Partial<LauncherPreferences>): Promise<OperationResult>;
  /** Opens the game folder in the file explorer. */
  openInstallFolder(): Promise<OperationResult>;
  /** Opens the launcher's own folder, on its startup log. */
  openLogsFolder(): Promise<OperationResult>;
  /** Opens the ROTK Discord invitation. */
  openDiscord(): Promise<OperationResult>;
  /**
   * The game folder: the bytes it takes on the disk, and whether it is a client
   * adopted where it stood (uninstalling then leaves the folder alone).
   */
  getInstallInfo(): Promise<OperationResult<{ bytes: number; adopted: boolean }>>;
  /** Copies again, from the H1Z1 this installation was made from, the files that are missing or of the wrong size. */
  repairGame(): Promise<OperationResult<{ installationRoot: string }>>;
  /** Removes the game. The window asks the player first. */
  uninstallGame(): Promise<OperationResult>;
  verifyAssets(): Promise<OperationResult>;
  restoreVanillaAssets(): Promise<OperationResult>;
  setAssetSyncEnabled(enabled: boolean): Promise<OperationResult>;
  setPlayerFont(id: string): Promise<OperationResult>;
  setLauncherFont(id: string): Promise<OperationResult>;
  getPlayerFontPreview(id: string): Promise<OperationResult<PlayerFontPreview>>;
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
  openSteamInstall: "launcher:open-steam-install",
  openSteamConsole: "launcher:open-steam-console",
  dismissError: "launcher:dismiss-error",
  listInstallDrives: "launcher:list-install-drives",
  chooseInstallDrive: "launcher:choose-install-drive",
  install: "launcher:install",
  cancelInstall: "launcher:cancel-install",
  play: "launcher:play",
  stopGame: "launcher:stop-game",
  openWebsite: "launcher:open-website",
  checkLauncherUpdate: "launcher:update-check",
  downloadLauncherUpdate: "launcher:update-download",
  installLauncherUpdate: "launcher:update-install",
  setLauncherUpdateAutoDownload: "launcher:update-set-auto-download",
  setPreferences: "launcher:set-preferences",
  openInstallFolder: "launcher:open-install-folder",
  openLogsFolder: "launcher:open-logs-folder",
  openDiscord: "launcher:open-discord",
  getInstallInfo: "launcher:install-info",
  repairGame: "launcher:repair-game",
  uninstallGame: "launcher:uninstall-game",
  verifyAssets: "asset-sync:verify",
  restoreVanillaAssets: "asset-sync:restore",
  setAssetSyncEnabled: "asset-sync:set-enabled",
  setPlayerFont: "player-font:set",
  setLauncherFont: "player-font:set-launcher",
  getPlayerFontPreview: "player-font:preview",
  minimizeWindow: "window:minimize",
  closeWindow: "window:close",
  snapshotChanged: "launcher:snapshot-changed",
} as const;
import type { AppLocale } from "./locale.js";
import type { LauncherPreferences } from "./preferences.js";
import type { LaunchProfileId, PlayerRole, ServerId } from "./launch-profile.js";
