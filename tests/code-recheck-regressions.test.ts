// Regressions found in review: a stale hash cache entry must not make every
// launch refuse an unchanged file, and a folder link named like a DLL is a folder.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findCodeChangedSinceMeasurement,
  measureInstallation,
} from "../electron/services/integrity-attestation";

let workspace: string;
let installRoot: string;
let userData: string;

const sha256 = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rotk-review-recheck-"));
  installRoot = join(workspace, "game");
  userData = join(workspace, "userdata");
  await mkdir(installRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("the pre-spawn recheck and the hash cache", () => {
  it("does not refuse a file that has not changed since the measurement when the hash cache was stale", async () => {
    // Any stale (path, size, mtime) cache entry: a copy that kept its
    // timestamps, a restored backup of the game folder or of userData.
    const path = "vivoxsdk_x64.dll";
    const absolute = join(installRoot, path);
    const before = "proxy build A";
    const after = "proxy build B";
    await writeFile(absolute, before);
    await utimes(absolute, 1_700_000_000, 1_700_000_000);
    const expected = [{ path, size: before.length, sha256: sha256(after) }];
    await measureInstallation({ installationRoot: installRoot, userDataDirectory: userData, expected, detectUnexpected: true });

    await writeFile(absolute, after);
    await utimes(absolute, 1_700_000_000, 1_700_000_000);

    // The launch measures, then nothing touches the folder until the spawn.
    for (let launch = 1; launch <= 2; launch += 1) {
      const measurement = await measureInstallation({
        installationRoot: installRoot, userDataDirectory: userData, expected, detectUnexpected: true,
      });
      await expect(findCodeChangedSinceMeasurement(installRoot, measurement.code)).resolves.toBeNull();
    }
  });

  it("does not refuse a folder link whose name ends in .dll when nothing changed", async () => {
    // listCodeFiles keeps any link with a code extension, including a junction
    // to a folder (or a broken link); the recheck then fails its isFile() test.
    await writeFile(join(installRoot, "H1Z1.exe"), "game executable");
    await mkdir(join(workspace, "elsewhere"), { recursive: true });
    await symlink(join(workspace, "elsewhere"), join(installRoot, "plugins.dll"), "junction");
    const measurement = await measureInstallation({
      installationRoot: installRoot, userDataDirectory: userData, expected: [], detectUnexpected: true,
    });
    await expect(findCodeChangedSinceMeasurement(installRoot, measurement.code)).resolves.toBeNull();
  });
});
