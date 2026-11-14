import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts the files that are read, to tell a cache hit from a fresh hash.
const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const createReadStream = ((path: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) => {
    reads.push(String(path));
    return actual.createReadStream(path, options);
  }) as typeof actual.createReadStream;
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});

const { measureInstallation, warmArchiveDigests } = await import("../electron/services/integrity-attestation");

const pack = "Resources/Assets/assets_x64_0.pack2";
const bank = "Resources/Audio/SFX.bnk_pc";
const font = "UI/Resource/Fonts/Montserrat-Bold.ttf";

let workspace: string;
let installRoot: string;
let userData: string;

async function writeGameFile(relativePath: string, content: string) {
  const absolute = join(installRoot, ...relativePath.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
  await utimes(absolute, 1_700_000_000, 1_700_000_000);
  return { path: relativePath, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}

const readCount = (relativePath: string) => reads.filter((path) => path.endsWith(join(...relativePath.split("/")))).length;
const warm = (shouldStop = () => false) => warmArchiveDigests({ installationRoot: installRoot, userDataDirectory: userData, shouldStop });

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rotk-digest-warmup-"));
  installRoot = join(workspace, "game");
  userData = join(workspace, "userdata");
  await mkdir(installRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
  reads.length = 0;
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("archive digest warm-up", () => {
  it("leaves the next measurement nothing to read but the files that are never cached", async () => {
    const expected = [await writeGameFile(pack, "pack bytes"), await writeGameFile(bank, "bank bytes"), await writeGameFile(font, "font bytes")];
    expect(await warm()).toBe(2);
    expect(readCount(font)).toBe(0);
    reads.length = 0;

    const measured = await measureInstallation({ installationRoot: installRoot, userDataDirectory: userData, expected });
    expect(measured.deviations).toEqual([]);
    expect(readCount(pack)).toBe(0);
    expect(readCount(bank)).toBe(0);
    expect(readCount(font)).toBe(1);
  });

  it("hashes only what changed since the last pass", async () => {
    await writeGameFile(pack, "pack bytes");
    await writeGameFile(bank, "bank bytes");
    await warm();
    await writeGameFile(bank, "bank bytes, replaced by an asset update");
    reads.length = 0;

    expect(await warm()).toBe(1);
    expect(readCount(pack)).toBe(0);
    expect(readCount(bank)).toBe(1);
  });

  it("reports an altered archive the same as without the warm-up", async () => {
    const expected = [await writeGameFile(pack, "pack bytes")];
    await writeGameFile(pack, "PACK BYTES");
    await warm();

    const measured = await measureInstallation({ installationRoot: installRoot, userDataDirectory: userData, expected });
    expect(measured.deviations.map(({ path, kind }) => ({ path, kind }))).toEqual([{ path: pack, kind: "mismatch" }]);
  });

  it("gives way when the launcher has something else to do", async () => {
    await writeGameFile(pack, "pack bytes");
    await writeGameFile(bank, "bank bytes");

    expect(await warm(() => true)).toBe(0);
    expect(reads).toEqual([]);

    // Busy from the first archive on: that one is read, never kept, and the pass ends.
    let asked = 0;
    expect(await warm(() => ++asked > 3)).toBe(0);
    expect(reads.length).toBe(1);
    reads.length = 0;
    expect(await warm()).toBe(2);
  });
});
