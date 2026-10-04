import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { retryFs } from "./fs-safe.js";
import { dirname, join } from "node:path";
import {
  isPlayerRole,
  isServerId,
  type PlayerRole,
  type ServerId,
} from "../../shared/launch-profile.js";

export interface InstalledClientConfig {
  installId: string;
  clientBuildId: string;
  root: string;
  sourceRoot: string;
  installedAt: string;
  criticalHashes: Record<string, string>;
}

export interface LauncherConfig {
  schemaVersion: 1;
  installation?: InstalledClientConfig;
  /** Custom asset synchronization before launch. Defaults to enabled. */
  assetSyncEnabled?: boolean;
  /** Native diagnostic observer for the next launched game; defaults to enabled. */
  diagnosticCaptureEnabled?: boolean;
  /** Optional full-session performance recording; off until the player enables it. */
  debugSessionEnabled?: boolean;
  /** Versioned consent to private upload, including quarantined memory dumps. */
  diagnosticUploadConsent?: 1;
  /**
   * Selected ROTK server. Absent means GAME 2: a launcher that never chose
   * must not silently connect to the test infrastructure. The single client
   * installation serves both — ClientConfig.ini is rewritten at every launch.
   */
  serverId?: ServerId;
  /** Launch as the player account or the admin/moderator one. Defaults to player. */
  role?: PlayerRole;
}

interface StoredConfigCandidate {
  path: string;
  config: LauncherConfig;
  needsRewrite: boolean;
}

export type InstallationMigrationValidator = (installation: InstalledClientConfig) => Promise<boolean>;

function freshConfig(): LauncherConfig {
  return { schemaVersion: 1 };
}

function isValidConfig(value: unknown): value is LauncherConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LauncherConfig>;
  const installation = candidate.installation;
  const installationIsValid =
    installation === undefined ||
    (typeof installation.installId === "string" &&
      typeof installation.clientBuildId === "string" &&
      typeof installation.root === "string" &&
      typeof installation.sourceRoot === "string" &&
      typeof installation.installedAt === "string" &&
      installation.criticalHashes !== null &&
      typeof installation.criticalHashes === "object");
  return (
    candidate.schemaVersion === 1 &&
    installationIsValid &&
    (candidate.assetSyncEnabled === undefined || typeof candidate.assetSyncEnabled === "boolean") &&
    (candidate.diagnosticCaptureEnabled === undefined || typeof candidate.diagnosticCaptureEnabled === "boolean") &&
    (candidate.debugSessionEnabled === undefined || typeof candidate.debugSessionEnabled === "boolean") &&
    (candidate.diagnosticUploadConsent === undefined || candidate.diagnosticUploadConsent === 1) &&
    (candidate.serverId === undefined || isServerId(candidate.serverId)) &&
    (candidate.role === undefined || isPlayerRole(candidate.role))
  );
}

function withoutLegacyIdentity(value: LauncherConfig): LauncherConfig {
  const next: LauncherConfig = { schemaVersion: 1 };
  if (value.installation) next.installation = value.installation;
  if (value.assetSyncEnabled !== undefined) next.assetSyncEnabled = value.assetSyncEnabled;
  if (value.diagnosticCaptureEnabled !== undefined) next.diagnosticCaptureEnabled = value.diagnosticCaptureEnabled;
  if (value.debugSessionEnabled !== undefined) next.debugSessionEnabled = value.debugSessionEnabled;
  if (value.diagnosticUploadConsent === 1) next.diagnosticUploadConsent = 1;
  if (value.serverId !== undefined) next.serverId = value.serverId;
  if (value.role !== undefined) next.role = value.role;
  return next;
}

export class ConfigStore {
  private readonly configPath: string;
  private readonly backupPath: string;
  private readonly legacyConfigPaths: readonly string[];
  private readonly validateMigratedInstallation: InstallationMigrationValidator | null;
  private config: LauncherConfig | null = null;

  constructor(
    userDataDirectory: string,
    legacyUserDataDirectories: readonly string[] = [],
    validateMigratedInstallation: InstallationMigrationValidator | null = null,
  ) {
    this.configPath = join(userDataDirectory, "config.v1.json");
    this.backupPath = join(userDataDirectory, "config.v1.backup.json");
    this.validateMigratedInstallation = validateMigratedInstallation;
    this.legacyConfigPaths = legacyUserDataDirectories.flatMap((directory) => [
      join(directory, "config.v1.json"),
      join(directory, "config.v1.backup.json"),
    ]);
  }

  async load(): Promise<LauncherConfig> {
    if (this.config) return this.config;

    const candidates = [this.configPath, this.backupPath, ...this.legacyConfigPaths];
    let firstValid: StoredConfigCandidate | null = null;
    let selected: StoredConfigCandidate | null = null;

    for (const path of [...new Set(candidates)]) {
      try {
        const parsed: unknown = JSON.parse(await retryFs(() => readFile(path, "utf8")));
        if (!isValidConfig(parsed)) continue;
        const candidate = {
          path,
          config: withoutLegacyIdentity(parsed),
          needsRewrite: Object.prototype.hasOwnProperty.call(parsed, "identity"),
        };
        if (
          path !== this.configPath
          && candidate.config.installation
          && this.validateMigratedInstallation
          && !await this.validateMigratedInstallation(candidate.config.installation)
        ) {
          continue;
        }
        firstValid ??= candidate;
        if (candidate.config.installation) {
          selected = candidate;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) continue;
        throw error;
      }
    }

    selected ??= firstValid;
    if (selected) {
      if (selected.path !== this.configPath || selected.needsRewrite) {
        await this.save(selected.config);
        if (selected.path !== this.configPath && selected.needsRewrite) {
          try {
            await this.writeAtomic(selected.path, selected.config);
          } catch {
            await rm(selected.path, { force: true });
          }
        }
      } else {
        this.config = selected.config;
        await this.writeBackup(selected.config);
      }
      return selected.config;
    }

    // Legacy configs could contain a player bearer. Replace unreadable state
    // instead of retaining it under a forensic backup filename.
    await rm(this.configPath, { force: true });
    this.config = freshConfig();
    await this.save(this.config);
    return this.config;
  }

  async setInstallation(installation: InstalledClientConfig): Promise<LauncherConfig> {
    const current = await this.load();
    const next: LauncherConfig = { ...current, installation };
    await this.save(next);
    return next;
  }

  /** Server and role are written together: a partial selection is never valid. */
  async setLaunchProfile(serverId: ServerId, role: PlayerRole): Promise<LauncherConfig> {
    if (!isServerId(serverId)) throw new Error("Unknown ROTK server");
    if (!isPlayerRole(role)) throw new Error("Unknown ROTK launch role");
    const current = await this.load();
    const next: LauncherConfig = { ...current, serverId, role };
    await this.save(next);
    return next;
  }

  async setAssetSyncEnabled(assetSyncEnabled: boolean): Promise<LauncherConfig> {
    const current = await this.load();
    const next: LauncherConfig = { ...current, assetSyncEnabled };
    await this.save(next);
    return next;
  }

  async save(next: LauncherConfig): Promise<void> {
    await this.writeAtomic(this.configPath, next);
    this.config = next;
    await this.writeBackup(next);
  }

  private async writeBackup(next: LauncherConfig): Promise<void> {
    try {
      await this.writeAtomic(this.backupPath, next);
    } catch {
      // The canonical file is authoritative. A backup failure must not turn a
      // completed multi-gigabyte client installation into a failed operation.
    }
  }

  private async writeAtomic(path: string, next: LauncherConfig): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await retryFs(() => rename(temporaryPath, path));
  }
}
