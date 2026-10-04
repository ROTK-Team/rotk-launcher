import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PlayerKeyStore, type PlayerKeyEncryption } from "../electron/services/player-key-store.js";

const temporaryDirectories: string[] = [];
const playerKey = "0123456789abcdef0123456789abcdef";
const adminKey = "fedcba9876543210fedcba9876543210";
const testServerKey = "aaaabbbbccccddddeeeeffff00001111";

const encryption: PlayerKeyEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from([...Buffer.from(value, "utf8")].map((byte) => byte ^ 0xa5)),
  decryptString: (value) => Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString("utf8"),
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rotk-key-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function storePaths(directory: string): { path: string; legacyPath: string } {
  return {
    path: join(directory, "player-keys.v2.json"),
    legacyPath: join(directory, "player-key.v1.json"),
  };
}

function newStore(directory: string): PlayerKeyStore {
  const { path, legacyPath } = storePaths(directory);
  return new PlayerKeyStore(path, encryption, legacyPath);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PlayerKeyStore", () => {
  it("persists the website keys only as encrypted data and restores them", async () => {
    const directory = await temporaryDirectory();
    const store = newStore(directory);

    await store.save("game2:player", playerKey);
    await store.save("game2:admin", adminKey);
    const serialized = await readFile(storePaths(directory).path, "utf8");

    expect(serialized).not.toContain(playerKey);
    expect(serialized).not.toContain(adminKey);
    await expect(newStore(directory).load()).resolves.toEqual({
      "game2:player": playerKey,
      "game2:admin": adminKey,
    });
  });

  it("keeps every server and role in its own slot", async () => {
    const directory = await temporaryDirectory();
    const store = newStore(directory);

    await store.save("game2:player", playerKey);
    await store.save("test:player", testServerKey);

    await expect(newStore(directory).load()).resolves.toEqual({
      "game2:player": playerKey,
      "test:player": testServerKey,
    });
  });

  it("clears one slot without touching the others", async () => {
    const directory = await temporaryDirectory();
    const store = newStore(directory);
    await store.save("game2:player", playerKey);
    await store.save("game2:admin", adminKey);

    await store.clear("game2:admin");

    await expect(newStore(directory).load()).resolves.toEqual({ "game2:player": playerKey });
  });

  it("migrates the 1.1.x single key into the GAME 2 player slot", async () => {
    const directory = await temporaryDirectory();
    const { legacyPath } = storePaths(directory);
    await writeFile(legacyPath, JSON.stringify({
      schemaVersion: 1,
      encryptedKey: encryption.encryptString(playerKey).toString("base64"),
    }), "utf8");

    await expect(newStore(directory).load()).resolves.toEqual({ "game2:player": playerKey });
    // The migrated file held a durable bearer; it is removed, not left behind.
    await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the 1.1.x key when the new file cannot be written", async () => {
    const directory = await temporaryDirectory();
    const { legacyPath } = storePaths(directory);
    const legacy = JSON.stringify({
      schemaVersion: 1,
      encryptedKey: encryption.encryptString(playerKey).toString("base64"),
    });
    await writeFile(legacyPath, legacy, "utf8");
    // A file where the profile folder should be makes the write fail.
    await writeFile(join(directory, "blocked"), "", "utf8");
    const store = new PlayerKeyStore(join(directory, "blocked", "player-keys.v2.json"), encryption, legacyPath);

    await expect(store.load()).resolves.toEqual({});
    await expect(readFile(legacyPath, "utf8")).resolves.toBe(legacy);
  });

  it("migrates before a first save so an older key is never overwritten", async () => {
    const directory = await temporaryDirectory();
    const { legacyPath } = storePaths(directory);
    await writeFile(legacyPath, JSON.stringify({
      schemaVersion: 1,
      encryptedKey: encryption.encryptString(playerKey).toString("base64"),
    }), "utf8");

    await newStore(directory).save("game2:admin", adminKey);

    await expect(newStore(directory).load()).resolves.toEqual({
      "game2:player": playerKey,
      "game2:admin": adminKey,
    });
  });

  it("drops only the slots this Windows account can no longer decrypt", async () => {
    const directory = await temporaryDirectory();
    const store = newStore(directory);
    await store.save("game2:player", playerKey);
    const { path } = storePaths(directory);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.keys["game2:admin"] = Buffer.from("not this account", "utf8").toString("base64");
    await writeFile(path, JSON.stringify(stored), "utf8");

    await expect(newStore(directory).load()).resolves.toEqual({ "game2:player": playerKey });
    expect(JSON.parse(await readFile(path, "utf8")).keys).not.toHaveProperty("game2:admin");
  });

  it("refuses plaintext fallback when secure storage is unavailable", async () => {
    const directory = await temporaryDirectory();
    const { path, legacyPath } = storePaths(directory);
    const unavailable = new PlayerKeyStore(
      path,
      { ...encryption, isEncryptionAvailable: () => false },
      legacyPath,
    );

    await expect(unavailable.save("game2:player", playerKey))
      .rejects.toThrow("Secure ROTK key storage is unavailable");
  });

  it("refuses a malformed key and an unknown launch profile", async () => {
    const directory = await temporaryDirectory();
    const store = newStore(directory);

    await expect(store.save("game2:player", "nope")).rejects.toThrow("Invalid ROTK player key");
    await expect(store.save("game3:player" as never, playerKey))
      .rejects.toThrow("Unknown ROTK launch profile");
  });
});
