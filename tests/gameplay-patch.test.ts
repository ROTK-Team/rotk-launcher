import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GAMEPLAY_MARKER_CONTENTS,
  GAMEPLAY_MARKER_FILE_NAME,
  GAMEPLAY_MARKER_SHA256,
  GAMEPLAY_PATCH_BYTES,
  GAMEPLAY_PATCH_FILE_NAME,
  GAMEPLAY_PATCH_SHA256,
  RETIRED_GAMEPLAY_PATCHES,
  gameplayPatchInternals,
  readCachedGameplayPatchMode,
  recordGameplayPatchState,
  type GameplayPatchPolicy,
} from "../electron/services/gameplay-patch.js";

const workspaces: string[] = [];
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const MARKER_CONTENTS =
  "mode=anti-slow-v3\npatch=1046F98:8f>82,1046FE5:74>eb\n";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rotk-gameplay-patch-"));
  workspaces.push(directory);
  const root = join(directory, "game");
  const userData = join(directory, "user-data");
  const bundledPath = join(directory, "bundled-dinput8.dll");
  const activePath = join(root, GAMEPLAY_PATCH_FILE_NAME);
  const active = "active v3 gameplay patch fixture";
  const retiredOld = "retired 1.4.3 gameplay patch fixture";
  const retiredStable = "retired stable gameplay fixture";
  const h1z1 = "supported H1Z1 fixture";
  const policy: GameplayPatchPolicy = {
    active: { sha256: digest(active), bytes: Buffer.byteLength(active) },
    retired: [
      { sha256: digest(retiredOld), bytes: Buffer.byteLength(retiredOld) },
      { sha256: digest(retiredStable), bytes: Buffer.byteLength(retiredStable) },
    ],
    marker: {
      fileName: GAMEPLAY_MARKER_FILE_NAME,
      contents: MARKER_CONTENTS,
      sha256: digest(MARKER_CONTENTS),
    },
    h1z1: { sha256: digest(h1z1), bytes: Buffer.byteLength(h1z1) },
  };
  await mkdir(root);
  await mkdir(userData);
  await writeFile(join(root, "H1Z1.exe"), h1z1);
  await writeFile(bundledPath, active);
  return {
    directory,
    root,
    userData,
    bundledPath,
    activePath,
    markerPath: join(root, GAMEPLAY_MARKER_FILE_NAME),
    active,
    retiredOld,
    retiredStable,
    h1z1,
    policy,
  };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("shotgun sprint patch deployment", () => {
  it("pins the v3 and retired production artifacts exactly", () => {
    expect(GAMEPLAY_PATCH_SHA256).toBe(
      "2c8c7d65f8410a2f05f58318978b44f08860c4f5647b5474a11bf70a0ebc0b3a",
    );
    expect(GAMEPLAY_PATCH_BYTES).toBe(34_304);
    expect(RETIRED_GAMEPLAY_PATCHES).toEqual([
      { sha256: "f27379c09f04db9abbeeaee56a0231fe7aeaa2e9570e670091c75a85871e67db", bytes: 33_792 },
      { sha256: "6ca1a0b1c28f8d11482a416e9f9d8b6330db253a78ed79b9301ec31198ce7845", bytes: 33_792 },
      { sha256: "36fba2037b0c9b1829e7c7e8bbedbcf5a962f495de4e8c63880b785745dcac3a", bytes: 25_088 },
      {
        sha256: "307603aaebdebf52fa55ad0a7337abd785e5190d1bf71e07520240fed51fbd7a",
        bytes: 24_064,
      },
      {
        sha256: "0d5603169fe86f874f9d6059a4f62a10b41d4dce31849561b59f0dc75e21a109",
        bytes: 21_504,
      },
    ]);
    expect(GAMEPLAY_MARKER_CONTENTS).toContain("mode=anti-slow-v3");
    expect(GAMEPLAY_MARKER_CONTENTS).toContain("patch=1046F98:8f>82,1046FE5:74>eb");
    expect(GAMEPLAY_MARKER_CONTENTS).toContain(
      "proxySha256=2C8C7D65F8410A2F05F58318978B44F08860C4F5647B5474A11BF70A0EBC0B3A",
    );
    expect(GAMEPLAY_MARKER_CONTENTS).toContain(
      "h1z1Sha256=5F5A4922B0671E4ED8FD415E753BE096EF7A17E360AE80E025F11544C8DB9261",
    );
    expect(GAMEPLAY_MARKER_SHA256).toBe(digest(GAMEPLAY_MARKER_CONTENTS));
  });

  it("accepts the exact artifact packaged by the launcher", async () => {
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    const bundledPath = join(repositoryRoot, "resources", "patches", "dinput8.dll");

    await expect(gameplayPatchInternals.assertBundledPatch(
      bundledPath,
      gameplayPatchInternals.DEFAULT_POLICY,
    )).resolves.toBeUndefined();
  });

  it("installs the DLL and its opt-in marker, then is idempotent", async () => {
    const value = await fixture();

    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        value.root,
        value.bundledPath,
        value.policy,
      ),
    ).resolves.toBe("installed");
    await expect(readFile(value.activePath, "utf8")).resolves.toBe(value.active);
    await expect(readFile(value.markerPath, "utf8")).resolves.toBe(MARKER_CONTENTS);

    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        value.root,
        value.bundledPath,
        value.policy,
      ),
    ).resolves.toBe("up-to-date");
  });

  it("repairs a missing marker without replacing the active DLL", async () => {
    const value = await fixture();
    await writeFile(value.activePath, value.active);

    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        value.root,
        value.bundledPath,
        value.policy,
      ),
    ).resolves.toBe("up-to-date");
    await expect(readFile(value.markerPath, "utf8")).resolves.toBe(MARKER_CONTENTS);
  });

  it("atomically replaces both retired ROTK artifacts", async () => {
    for (const retired of ["retiredOld", "retiredStable"] as const) {
      const value = await fixture();
      await writeFile(value.activePath, value[retired]);

      await expect(
        gameplayPatchInternals.deployGameplayPatchWithPolicy(
          value.root,
          value.bundledPath,
          value.policy,
        ),
      ).resolves.toBe("replaced");
      await expect(readFile(value.activePath, "utf8")).resolves.toBe(value.active);
    }
  });

  it("validates the bundled artifact before changing the client", async () => {
    const value = await fixture();
    await writeFile(value.activePath, value.retiredOld);
    await writeFile(value.bundledPath, "corrupt bundled patch");

    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        value.root,
        value.bundledPath,
        value.policy,
      ),
    ).rejects.toThrow(/embarqué est invalide/i);
    await expect(readFile(value.activePath, "utf8")).resolves.toBe(value.retiredOld);
  });

  it("rejects an unsupported H1Z1 build before changing the client", async () => {
    const value = await fixture();
    await writeFile(value.activePath, value.retiredOld);
    await writeFile(join(value.root, "H1Z1.exe"), "unsupported H1Z1");

    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        value.root,
        value.bundledPath,
        value.policy,
      ),
    ).rejects.toThrow(/version de H1Z1.+pas compatible/i);
    await expect(readFile(value.activePath, "utf8")).resolves.toBe(value.retiredOld);
  });

  it("leaves an unknown same-size DLL untouched and blocks deployment", async () => {
    const value = await fixture();
    const unknown = "x".repeat(value.policy.active.bytes);
    await writeFile(value.activePath, unknown);

    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        value.root,
        value.bundledPath,
        value.policy,
      ),
    ).rejects.toThrow(/dinput8[.]dll inconnu/i);
    await expect(readFile(value.activePath, "utf8")).resolves.toBe(unknown);
  });

  it("fails closed when the marker cannot be written", async () => {
    const value = await fixture();
    await mkdir(value.markerPath);

    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        value.root,
        value.bundledPath,
        value.policy,
      ),
    ).rejects.toThrow(/marqueur/i);
    await expect(stat(value.activePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves links and directories untouched and blocks deployment", async () => {
    const directoryValue = await fixture();
    await mkdir(directoryValue.activePath);
    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        directoryValue.root,
        directoryValue.bundledPath,
        directoryValue.policy,
      ),
    ).rejects.toThrow(/dinput8[.]dll inconnu/i);
    await expect(stat(directoryValue.activePath).then((entry) => entry.isDirectory()))
      .resolves.toBe(true);

    const linkValue = await fixture();
    // A directory junction exercises the Windows reparse-point path without
    // requiring the elevated privilege needed to create a file symlink.
    const unrelated = join(linkValue.root, "unrelated-directory");
    const sentinel = join(unrelated, "sentinel.txt");
    await mkdir(unrelated);
    await writeFile(sentinel, linkValue.retiredOld);
    await symlink(unrelated, linkValue.activePath, "junction");
    await expect(
      gameplayPatchInternals.deployGameplayPatchWithPolicy(
        linkValue.root,
        linkValue.bundledPath,
        linkValue.policy,
      ),
    ).rejects.toThrow(/dinput8[.]dll inconnu/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe(linkValue.retiredOld);
  });
});

describe("shotgun sprint patch depatch", () => {
  it("removes the marker first and then the active DLL, idempotently", async () => {
    const value = await fixture();
    await writeFile(value.activePath, value.active);
    await writeFile(value.markerPath, MARKER_CONTENTS);

    await expect(
      gameplayPatchInternals.depatchGameplayPatchWithPolicy(value.root, value.policy),
    ).resolves.toBe("removed");
    await expect(stat(value.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(value.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      gameplayPatchInternals.depatchGameplayPatchWithPolicy(value.root, value.policy),
    ).resolves.toBe("absent");
  });

  it("also removes the exact retired artifacts", async () => {
    for (const key of ["retiredOld", "retiredStable"] as const) {
      const value = await fixture();
      await writeFile(value.activePath, value[key]);

      await expect(
        gameplayPatchInternals.depatchGameplayPatchWithPolicy(value.root, value.policy),
      ).resolves.toBe("removed");
      await expect(stat(value.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves an unknown DLL and blocks the rollback", async () => {
    const value = await fixture();
    const unknown = "x".repeat(value.policy.active.bytes);
    await writeFile(value.activePath, unknown);

    await expect(
      gameplayPatchInternals.depatchGameplayPatchWithPolicy(value.root, value.policy),
    ).rejects.toThrow(/dinput8[.]dll inconnu/i);
    await expect(readFile(value.activePath, "utf8")).resolves.toBe(unknown);
  });
});

describe("shotgun sprint patch state", () => {
  it("classifies and rechecks both modes", async () => {
    const value = await fixture();
    await expect(
      gameplayPatchInternals.gameplayPatchInstallStateWithPolicy(value.root, value.policy),
    ).resolves.toBe("clean");

    await gameplayPatchInternals.deployGameplayPatchWithPolicy(
      value.root,
      value.bundledPath,
      value.policy,
    );
    await expect(
      gameplayPatchInternals.gameplayPatchInstallStateWithPolicy(value.root, value.policy),
    ).resolves.toBe("patched");
    await expect(
      gameplayPatchInternals.assertGameplayPatchStateWithPolicy(
        value.root,
        "patched",
        value.policy,
      ),
    ).resolves.toBeUndefined();

    await rm(value.markerPath, { force: true });
    await expect(
      gameplayPatchInternals.assertGameplayPatchStateWithPolicy(
        value.root,
        "patched",
        value.policy,
      ),
    ).rejects.toThrow(/installé/i);

    await gameplayPatchInternals.depatchGameplayPatchWithPolicy(value.root, value.policy);
    await expect(
      gameplayPatchInternals.assertGameplayPatchStateWithPolicy(
        value.root,
        "clean",
        value.policy,
      ),
    ).resolves.toBeUndefined();
  });

  it("round-trips the last server-directed mode in AppData", async () => {
    const value = await fixture();
    await expect(readCachedGameplayPatchMode(value.userData)).resolves.toBeNull();

    await recordGameplayPatchState(value.userData, {
      mode: "patched",
      dllSha256: GAMEPLAY_PATCH_SHA256,
      markerSha256: GAMEPLAY_MARKER_SHA256,
      policyVersion: "2026.09.18-0001",
    });
    await expect(readCachedGameplayPatchMode(value.userData)).resolves.toBe("patched");

    await recordGameplayPatchState(value.userData, {
      mode: "clean",
      dllSha256: null,
      markerSha256: null,
      policyVersion: "2026.09.18-0002",
    });
    await expect(readCachedGameplayPatchMode(value.userData)).resolves.toBe("clean");

    await writeFile(
      join(value.userData, gameplayPatchInternals.STATE_FILE_NAME),
      "not json",
    );
    await expect(readCachedGameplayPatchMode(value.userData)).resolves.toBeNull();
  });
});
