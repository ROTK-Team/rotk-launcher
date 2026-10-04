import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { retryFs } from "./fs-safe.js";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isValidPlayerKey, normalizePlayerKey } from "../../shared/player-key.js";
import {
  DEFAULT_SERVER_ID,
  LAUNCH_PROFILE_IDS,
  isLaunchProfileId,
  launchProfileId,
  type LaunchProfileId,
} from "../../shared/launch-profile.js";

/** Base64 ciphertext per launch profile; a slot is absent until a key is saved. */
interface StoredPlayerKeys {
  schemaVersion: 2;
  keys: Partial<Record<LaunchProfileId, string>>;
}

/** The single-key record written by launchers up to 1.1.x. */
interface LegacyStoredPlayerKey {
  schemaVersion: 1;
  encryptedKey: string;
}

export type PlayerKeySet = Partial<Record<LaunchProfileId, string>>;

export interface PlayerKeyEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isCiphertext(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && BASE64_PATTERN.test(value);
}

function isStoredPlayerKeys(value: unknown): value is StoredPlayerKeys {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredPlayerKeys>;
  if (candidate.schemaVersion !== 2) return false;
  const keys = candidate.keys;
  if (!keys || typeof keys !== "object") return false;
  return Object.entries(keys).every(([profile, ciphertext]) =>
    isLaunchProfileId(profile) && isCiphertext(ciphertext));
}

function isLegacyStoredPlayerKey(value: unknown): value is LegacyStoredPlayerKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyStoredPlayerKey>;
  return candidate.schemaVersion === 1 && isCiphertext(candidate.encryptedKey);
}

/**
 * Stores the website-issued bearers encrypted by Electron safeStorage/Windows
 * DPAPI, one slot per server and role.
 *
 * The slots are deliberately independent: an administrator key belongs to a
 * different ROTK account than the player key beside it, and the test server
 * keeps its own account database. Merging them would silently send one server's
 * credential to another, which the account service answers with a flat
 * `invalid_credentials` — indistinguishable from a revoked key.
 */
export class PlayerKeyStore {
  constructor(
    private readonly path: string,
    private readonly encryption: PlayerKeyEncryption,
    /** Path of the 1.1.x single-key file, migrated into the GAME 2 player slot. */
    private readonly legacyPath: string | null = null,
  ) {}

  async load(): Promise<PlayerKeySet> {
    if (!this.encryption.isEncryptionAvailable()) return {};
    const stored = await this.readStored();
    if (stored === null) return this.migrateLegacy();

    const keys: PlayerKeySet = {};
    const surviving: Partial<Record<LaunchProfileId, string>> = {};
    for (const profile of LAUNCH_PROFILE_IDS) {
      const ciphertext = stored.keys[profile];
      if (ciphertext === undefined) continue;
      try {
        const playerKey = this.encryption.decryptString(Buffer.from(ciphertext, "base64"));
        if (!isValidPlayerKey(playerKey)) throw new Error("Invalid decrypted player key");
        keys[profile] = normalizePlayerKey(playerKey);
        surviving[profile] = ciphertext;
      } catch {
        // A key that cannot be decrypted for this Windows account is unusable.
        // Drop that slot instead of failing every load, and keep the others.
      }
    }
    if (Object.keys(surviving).length !== Object.keys(stored.keys).length) {
      await this.writeStored({ schemaVersion: 2, keys: surviving }).catch(() => undefined);
    }
    return keys;
  }

  async save(profile: LaunchProfileId, value: unknown): Promise<string> {
    if (!isLaunchProfileId(profile)) throw new Error("Unknown ROTK launch profile");
    if (!isValidPlayerKey(value)) throw new Error("Invalid ROTK player key");
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure ROTK key storage is unavailable on this Windows account");
    }
    const playerKey = normalizePlayerKey(value);
    const stored = await this.readOrMigrate();
    stored.keys[profile] = this.encryption.encryptString(playerKey).toString("base64");
    await this.writeStored(stored);
    return playerKey;
  }

  async clear(profile: LaunchProfileId): Promise<void> {
    if (!isLaunchProfileId(profile)) throw new Error("Unknown ROTK launch profile");
    const stored = await this.readOrMigrate();
    if (stored.keys[profile] === undefined) return;
    delete stored.keys[profile];
    await this.writeStored(stored);
  }

  private async readOrMigrate(): Promise<StoredPlayerKeys> {
    const existing = await this.readStored();
    if (existing) return existing;
    // Migrating first keeps a save() that precedes any load() from overwriting
    // a key the player configured with an earlier launcher.
    await this.migrateLegacy();
    return (await this.readStored()) ?? { schemaVersion: 2, keys: {} };
  }

  private async readStored(): Promise<StoredPlayerKeys | null> {
    try {
      const parsed: unknown = JSON.parse(await retryFs(() => readFile(this.path, "utf8")));
      if (!isStoredPlayerKeys(parsed)) throw new Error("Invalid encrypted player key record");
      return { schemaVersion: 2, keys: { ...parsed.keys } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A locked file (antivirus, sync client) is not a corrupt one: keep the key.
      if ((error as NodeJS.ErrnoException).code) throw error;
      // Unreadable credential state is replaced, never retained under a
      // forensic filename: it may hold a durable bearer.
      await rm(this.path, { force: true });
      return null;
    }
  }

  private async migrateLegacy(): Promise<PlayerKeySet> {
    if (!this.legacyPath) return {};
    const profile = launchProfileId(DEFAULT_SERVER_ID, "player");
    try {
      const parsed: unknown = JSON.parse(await retryFs(() => readFile(this.legacyPath!, "utf8")));
      if (!isLegacyStoredPlayerKey(parsed)) throw new Error("Invalid encrypted player key record");
      const playerKey = this.encryption.decryptString(Buffer.from(parsed.encryptedKey, "base64"));
      if (!isValidPlayerKey(playerKey)) throw new Error("Invalid decrypted player key");
      await this.writeStored({ schemaVersion: 2, keys: { [profile]: parsed.encryptedKey } });
      // The key is migrated: a leftover legacy file is never read again.
      await rm(this.legacyPath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
      return { [profile]: normalizePlayerKey(playerKey) };
    } catch (error) {
      // Absent is the ordinary case. A locked file or a failed write keeps the
      // legacy key for the next start; only an unusable record is removed.
      if (!(error as NodeJS.ErrnoException).code) {
        await rm(this.legacyPath, { force: true });
      }
      return {};
    }
  }

  private async writeStored(next: StoredPlayerKeys): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await retryFs(() => rename(temporaryPath, this.path));
  }
}
