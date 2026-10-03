import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSteamShim,
  deploySteamShim,
  steamShimInternals,
} from "../electron/services/steam-shim.js";

const temporaryDirectories: string[] = [];
const writes = vi.hoisted(() => ({
  copies: [] as string[],
  renames: [] as string[],
  failRename: null as { error: NodeJS.ErrnoException; times: number } | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: (...args: Parameters<typeof fs.copyFile>) => {
      writes.copies.push(String(args[1]));
      return fs.copyFile(...args);
    },
    rename: (...args: Parameters<typeof fs.rename>) => {
      writes.renames.push(String(args[1]));
      const failure = writes.failRename;
      if (failure && failure.times > 0) {
        failure.times -= 1;
        return Promise.reject(failure.error);
      }
      return fs.rename(...args);
    },
  };
});

const contents = {
  bundled: Buffer.from("rotk-steam-shim-current-release"),
  // Same size as the bundled shim: only the hash can tell them apart.
  previous: Buffer.from("rotk-steam-shim-previous-releas"),
};

async function createFixture(): Promise<{ root: string; bundled: string; active: string }> {
  const directory = await mkdtemp(join(tmpdir(), "rotk-steam-shim-test-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "game");
  const bundled = join(directory, "bundled-steam_api64.dll");
  await mkdir(root);
  await writeFile(bundled, contents.bundled);
  return { root, bundled, active: join(root, "steam_api64.dll") };
}

beforeEach(() => {
  writes.copies.length = 0;
  writes.renames.length = 0;
  writes.failRename = null;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("Steam shim deployment", () => {
  it("replaces a shim left by a previous launcher release with the bundled bytes", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.active, contents.previous);

    await deploySteamShim(fixture.root, fixture.bundled);

    expect(await readFile(fixture.active)).toEqual(contents.bundled);
    expect(await steamShimInternals.sha256(fixture.active))
      .toBe(createHash("sha256").update(contents.bundled).digest("hex"));
    expect(writes.renames).toEqual([fixture.active]);
    // Staged next to the target, then renamed over it: nothing is left behind.
    expect(writes.copies).toHaveLength(1);
    expect(writes.copies[0]).toMatch(/steam_api64\.dll\.rotk-[0-9a-f-]+\.tmp$/);
    expect(await readdir(fixture.root)).toEqual(["steam_api64.dll"]);
  });

  it("deploys a missing shim", async () => {
    const fixture = await createFixture();

    await deploySteamShim(fixture.root, fixture.bundled);

    expect(await readFile(fixture.active)).toEqual(contents.bundled);
    expect(await readdir(fixture.root)).toEqual(["steam_api64.dll"]);
  });

  it("does not rewrite a shim that already matches the bundled one", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.active, contents.bundled);
    const past = new Date("2026-01-01T00:00:00Z");
    await utimes(fixture.active, past, past);
    const before = await stat(fixture.active);

    await deploySteamShim(fixture.root, fixture.bundled);
    await deploySteamShim(fixture.root, fixture.bundled);

    // A stable mtime keeps the integrity hash cache valid and spares the
    // antivirus a rescan of an unchanged DLL.
    expect(writes.copies).toEqual([]);
    expect(writes.renames).toEqual([]);
    expect((await stat(fixture.active)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(fixture.active)).toEqual(contents.bundled);
  });

  it("retries a replacement the antivirus holds for a moment", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.active, contents.previous);
    const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    writes.failRename = { error: busy, times: 1 };

    await deploySteamShim(fixture.root, fixture.bundled);

    expect(await readFile(fixture.active)).toEqual(contents.bundled);
    expect(writes.copies).toHaveLength(1);
    expect(writes.renames).toEqual([fixture.active, fixture.active]);
    expect(await readdir(fixture.root)).toEqual(["steam_api64.dll"]);
  });

  it("removes the staging file and keeps the old shim when the replacement keeps failing", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.active, contents.previous);
    const denied = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    writes.failRename = { error: denied, times: Infinity };

    // The system error itself surfaces, so the player is told which file is locked.
    await expect(deploySteamShim(fixture.root, fixture.bundled))
      .rejects.toMatchObject({ code: "EPERM" });

    expect(writes.copies).toHaveLength(1);
    expect(await readFile(fixture.active)).toEqual(contents.previous);
    expect(await readdir(fixture.root)).toEqual(["steam_api64.dll"]);
  });

  it("fails before touching the install when the bundled shim is unreadable", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.active, contents.previous);
    await rm(fixture.bundled);

    await expect(deploySteamShim(fixture.root, fixture.bundled))
      .rejects.toThrow(/shim Steam ROTK embarqué est absent ou modifié/);

    expect(writes.copies).toEqual([]);
    expect(await readFile(fixture.active)).toEqual(contents.previous);
  });
});

describe("Steam shim check before spawn", () => {
  it("passes when the installed shim matches the bundled one", async () => {
    const fixture = await createFixture();
    await deploySteamShim(fixture.root, fixture.bundled);

    await expect(assertSteamShim(fixture.root, fixture.bundled)).resolves.toBeUndefined();
  });

  it("refuses a same-size mismatch without repairing it", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.active, contents.previous);

    await expect(assertSteamShim(fixture.root, fixture.bundled))
      .rejects.toThrow(/shim Steam ROTK n'a pas été copié correctement/);

    expect(writes.copies).toEqual([]);
    expect(await readFile(fixture.active)).toEqual(contents.previous);
  });

  it("refuses a missing shim, even when the bundled one is missing too", async () => {
    const fixture = await createFixture();

    await expect(assertSteamShim(fixture.root, fixture.bundled))
      .rejects.toThrow(/shim Steam ROTK n'a pas été copié correctement/);

    await rm(fixture.bundled);
    await expect(assertSteamShim(fixture.root, fixture.bundled))
      .rejects.toThrow(/shim Steam ROTK embarqué est absent ou modifié/);
  });
});
