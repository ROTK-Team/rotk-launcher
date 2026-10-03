import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../electron/services/config-store.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rotk-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ConfigStore", () => {
  const installation = {
    installId: "install-1",
    clientBuildId: "h1z1-1.0.326.439939",
    root: "E:\\ROTK\\ROTK-H1Z1",
    sourceRoot: "E:\\SteamLibrary\\steamapps\\common\\H1Z1",
    installedAt: "2026-07-20T12:00:00.000Z",
    criticalHashes: {
      "H1Z1.exe": "a".repeat(64),
      "ClientConfig.ini": "b".repeat(64),
      "steam_api64.dll": "c".repeat(64),
    },
  };

  it("creates installation-free state without a player identity", async () => {
    const directory = await temporaryDirectory();
    const first = await new ConfigStore(directory).load();
    const reloaded = await new ConfigStore(directory).load();
    const persisted = JSON.parse(await readFile(join(directory, "config.v1.json"), "utf8"));

    expect(first).toEqual({ schemaVersion: 1 });
    expect(reloaded).toEqual(first);
    expect(persisted).toEqual({ schemaVersion: 1 });
    expect(persisted).not.toHaveProperty("identity");
  });

  it("restores a completed installation after a launcher restart", async () => {
    const directory = await temporaryDirectory();
    await new ConfigStore(directory).setInstallation(installation);

    const reloaded = await new ConfigStore(directory).load();

    expect(reloaded).toEqual({ schemaVersion: 1, installation });
    expect(reloaded).not.toHaveProperty("identity");
  });

  it("recovers the remembered installation when the primary config is damaged", async () => {
    const directory = await temporaryDirectory();
    await new ConfigStore(directory).setInstallation(installation);
    await writeFile(join(directory, "config.v1.json"), "{broken", "utf8");

    const recovered = await new ConfigStore(directory).load();
    const persisted = JSON.parse(await readFile(join(directory, "config.v1.json"), "utf8"));

    expect(recovered).toEqual({ schemaVersion: 1, installation });
    expect(persisted).toEqual(recovered);
  });

  it("migrates a remembered installation from an older launcher data directory", async () => {
    const directory = await temporaryDirectory();
    const legacyDirectory = join(directory, "legacy");
    const canonicalDirectory = join(directory, "canonical");
    await new ConfigStore(legacyDirectory).setInstallation(installation);

    const migrated = await new ConfigStore(canonicalDirectory, [legacyDirectory]).load();
    const persisted = JSON.parse(await readFile(join(canonicalDirectory, "config.v1.json"), "utf8"));

    expect(migrated).toEqual({ schemaVersion: 1, installation });
    expect(persisted).toEqual(migrated);
  });

  it("skips a stale legacy installation in favor of the next valid candidate", async () => {
    const directory = await temporaryDirectory();
    const staleDirectory = join(directory, "stale");
    const validDirectory = join(directory, "valid");
    const canonicalDirectory = join(directory, "canonical");
    await new ConfigStore(staleDirectory).setInstallation({ ...installation, root: "E:\\ROTK\\missing" });
    await new ConfigStore(validDirectory).setInstallation({ ...installation, root: "E:\\ROTK\\valid" });

    const migrated = await new ConfigStore(
      canonicalDirectory,
      [staleDirectory, validDirectory],
      async (candidate) => candidate.root.endsWith("\\valid"),
    ).load();

    expect(migrated.installation?.root).toBe("E:\\ROTK\\valid");
  });

  it("scrubs a player identity from the legacy source after migration", async () => {
    const directory = await temporaryDirectory();
    const legacyDirectory = join(directory, "legacy");
    const canonicalDirectory = join(directory, "canonical");
    await new ConfigStore(legacyDirectory).setInstallation(installation);
    await writeFile(join(legacyDirectory, "config.v1.json"), JSON.stringify({
      schemaVersion: 1,
      installation,
      identity: { authKey: "0123456789abcdef0123456789abcdef" },
    }), "utf8");

    await new ConfigStore(canonicalDirectory, [legacyDirectory], async () => true).load();
    const legacy = JSON.parse(await readFile(join(legacyDirectory, "config.v1.json"), "utf8"));

    expect(legacy).toEqual({ schemaVersion: 1, installation });
    expect(legacy).not.toHaveProperty("identity");
  });

  it("scrubs a legacy persisted identity during migration", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "config.v1.json"), JSON.stringify({
      schemaVersion: 1,
      identity: {
        authKey: "0123456789abcdef0123456789abcdef",
        persona: "Survivor-0123",
        steamId: "76561198000000001",
      },
    }), "utf8");

    const loaded = await new ConfigStore(directory).load();
    const persisted = JSON.parse(await readFile(join(directory, "config.v1.json"), "utf8"));

    expect(loaded).toEqual({ schemaVersion: 1 });
    expect(persisted).toEqual({ schemaVersion: 1 });
  });

  it("remembers an unfinished install across restarts until it completes", async () => {
    const directory = await temporaryDirectory();
    await new ConfigStore(directory).setPendingInstallRoot("D:\\Games\\ROTK");
    const store = new ConfigStore(directory);
    expect(await store.load()).toEqual({ schemaVersion: 1, pendingInstallRoot: "D:\\Games\\ROTK" });

    await store.setInstallation(installation);
    expect(await new ConfigStore(directory).load()).toEqual({ schemaVersion: 1, installation });
  });

  it("remembers the selected server and role across restarts", async () => {
    const directory = await temporaryDirectory();
    await new ConfigStore(directory).setLaunchProfile("test", "admin");

    const reloaded = await new ConfigStore(directory).load();

    expect(reloaded).toEqual({ schemaVersion: 1, serverId: "test", role: "admin" });
  });

  it("keeps Debug opt-in and persists it independently of native crash capture", async () => {
    const directory = await temporaryDirectory();
    const store = new ConfigStore(directory);
    expect((await store.load()).debugSessionEnabled).toBeUndefined();
    await store.save({ schemaVersion: 1, diagnosticCaptureEnabled: false, debugSessionEnabled: true });
    expect(await new ConfigStore(directory).load()).toEqual({ schemaVersion: 1, diagnosticCaptureEnabled: false, debugSessionEnabled: true });
    await store.save({ schemaVersion: 1, debugSessionEnabled: false });
    expect((await new ConfigStore(directory).load()).debugSessionEnabled).toBe(false);
  });

  it("falls back to a fresh state rather than trusting an unknown server", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "config.v1.json"), JSON.stringify({
      schemaVersion: 1,
      installation,
      serverId: "game3",
    }), "utf8");
    await rm(join(directory, "config.v1.backup.json"), { force: true });

    const loaded = await new ConfigStore(directory).load();

    expect(loaded).toEqual({ schemaVersion: 1 });
  });

  it("refuses to persist a server or role it does not define", async () => {
    const directory = await temporaryDirectory();
    const store = new ConfigStore(directory);

    await expect(store.setLaunchProfile("game3" as never, "player"))
      .rejects.toThrow("Unknown ROTK server");
    await expect(store.setLaunchProfile("game2", "owner" as never))
      .rejects.toThrow("Unknown ROTK launch role");
  });

  it("removes a corrupt legacy file instead of retaining a possible player key", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "config.v1.json"), "{broken", "utf8");

    const recovered = await new ConfigStore(directory).load();
    const files = await readdir(directory);

    expect(recovered.schemaVersion).toBe(1);
    expect(files).toContain("config.v1.json");
    expect(files.some((file) => file.startsWith("config.v1.json.corrupt-"))).toBe(false);
  });
});
