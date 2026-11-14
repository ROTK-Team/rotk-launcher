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
  /** Destination of a copy install that has not finished yet, so it resumes after a restart. */
  pendingInstallRoot?: string;
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
  /** Interface font id from resources/fonts/manifest.json; absent means the stock fonts. */
  playerFont?: string;
  /** Same ids, for the launcher's own interface; absent means its stock fonts. */
  launcherFont?: string;
}

interface StoredConfigCandidate {
  path: string;
  config: LauncherConfig;
  needsRewrite: boolean;
  /** Stored fields this build could not read. */
  ignored: string[];
}

export type InstallationMigrationValidator = (installation: InstalledClientConfig) => Promise<boolean>;

function freshConfig(): LauncherConfig {
  return { schemaVersion: 1 };
}

function isInstallation(value: unknown): value is InstalledClientConfig {
  if (!value || typeof value !== "object") return false;
  const installation = value as Partial<InstalledClientConfig>;
  return typeof installation.installId === "string"
    && typeof installation.clientBuildId === "string"
    && typeof installation.root === "string"
    && typeof installation.sourceRoot === "string"
    && typeof installation.installedAt === "string"
    && installation.criticalHashes !== null
    && typeof installation.criticalHashes === "object";
}

const isFontId = (value: unknown): boolean => typeof value === "string" && /^[a-z0-9]{1,32}$/.test(value);
const isBoolean = (value: unknown): boolean => typeof value === "boolean";

/** What makes each stored field usable by this build. */
const FIELD_VALIDATORS: { [K in Exclude<keyof LauncherConfig, "schemaVersion">]-?: (value: unknown) => boolean } = {
  installation: isInstallation,
  pendingInstallRoot: (value) => typeof value === "string",
  assetSyncEnabled: isBoolean,
  diagnosticCaptureEnabled: isBoolean,
  debugSessionEnabled: isBoolean,
  diagnosticUploadConsent: (value) => value === 1,
  serverId: isServerId,
  role: isPlayerRole,
  playerFont: isFontId,
  launcherFont: isFontId,
};

/**
 * Reads a stored configuration field by field: what this build understands is
 * kept, the rest is listed in `ignored` and left out. Null when the file is
 * not a configuration of this schema at all.
 *
 * The file used to be valid as a whole or not at all. One value this build did
 * not know (a server, a role or a font written by a newer or a beta launcher)
 * made the whole file invalid, its backup with it, and the launcher started as
 * if nothing had ever been installed, without a word. Fields that are not part
 * of the configuration, such as the player identity of old launchers, are
 * left out too.
 */
function readConfig(value: unknown): { config: LauncherConfig; ignored: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as Record<string, unknown>;
  if (stored.schemaVersion !== 1) return null;
  const config: Record<string, unknown> = { schemaVersion: 1 };
  const ignored: string[] = [];
  for (const [field, isValid] of Object.entries(FIELD_VALIDATORS)) {
    const fieldValue = stored[field];
    if (fieldValue === undefined) continue;
    if (isValid(fieldValue)) config[field] = fieldValue;
    else ignored.push(field);
  }
  return { config: config as unknown as LauncherConfig, ignored };
}

export class ConfigStore {
  private readonly configPath: string;
  private readonly backupPath: string;
  private readonly legacyConfigPaths: readonly string[];
  private readonly validateMigratedInstallation: InstallationMigrationValidator | null;
  private readonly onIgnoredFields: (fields: string[]) => void;
  private config: LauncherConfig | null = null;

  constructor(
    userDataDirectory: string,
    legacyUserDataDirectories: readonly string[] = [],
    validateMigratedInstallation: InstallationMigrationValidator | null = null,
    /** Fields of the configuration in use that this build could not read; for the launcher log. */
    onIgnoredFields: (fields: string[]) => void = () => undefined,
  ) {
    this.onIgnoredFields = onIgnoredFields;
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
        const read = readConfig(parsed);
        if (!read) continue;
        const candidate = {
          path,
          config: read.config,
          needsRewrite: Object.prototype.hasOwnProperty.call(parsed, "identity"),
          ignored: read.ignored,
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
      if (selected.ignored.length > 0) this.onIgnoredFields(selected.ignored);
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

  /** Also clears the pending install: it just finished. */
  async setInstallation(installation: InstalledClientConfig): Promise<LauncherConfig> {
    const { pendingInstallRoot: _finished, ...current } = await this.load();
    const next: LauncherConfig = { ...current, installation };
    await this.save(next);
    return next;
  }

  async setPendingInstallRoot(pendingInstallRoot: string): Promise<LauncherConfig> {
    const current = await this.load();
    const next: LauncherConfig = { ...current, pendingInstallRoot };
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

  async setPlayerFont(playerFont: string): Promise<LauncherConfig> {
    const current = await this.load();
    const next: LauncherConfig = { ...current, playerFont };
    await this.save(next);
    return next;
  }

  async setLauncherFont(launcherFont: string): Promise<LauncherConfig> {
    const current = await this.load();
    const next: LauncherConfig = { ...current, launcherFont };
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
