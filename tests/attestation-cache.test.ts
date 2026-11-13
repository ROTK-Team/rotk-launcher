import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts the files the measurement reads, to tell a cache hit from a fresh hash.
const reads = vi.hoisted(() => [] as string[]);
// Error codes the next reads of a file fail with (an antivirus holding it, a dying disk).
const failures = vi.hoisted(() => new Map<string, string[]>());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { Readable } = await import("node:stream");
  const createReadStream = ((path: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) => {
    reads.push(String(path));
    const pending = [...failures.entries()].find(([suffix]) => String(path).endsWith(suffix))?.[1];
    const code = pending?.shift();
    if (code) {
      const stream = new Readable({ read() {} });
      queueMicrotask(() => stream.destroy(Object.assign(new Error(`${code}: fixture`), { code })));
      return stream as unknown as ReturnType<typeof actual.createReadStream>;
    }
    return actual.createReadStream(path, options);
  }) as typeof actual.createReadStream;
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});

const { measureInstallation } = await import("../electron/services/integrity-attestation");

let workspace: string;
let installRoot: string;
let userData: string;

function sha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function writeGameFile(relativePath: string, content: string) {
  const absolute = join(installRoot, ...relativePath.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
  await utimes(absolute, 1_700_000_000, 1_700_000_000);
  return { path: relativePath, size: Buffer.byteLength(content), sha256: sha256(content) };
}

const readCount = (relativePath: string) => reads.filter((path) => path.endsWith(join(...relativePath.split("/")))).length;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rotk-attest-cache-"));
  installRoot = join(workspace, "game");
  userData = join(workspace, "userdata");
  await mkdir(installRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
  reads.length = 0;
  failures.clear();
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("hash cache", () => {
  const pack = "Resources/Assets/assets_x64_0.pack2";
  const font = "UI/Resource/Fonts/Montserrat-Bold.ttf";

  async function measuredTwice() {
    const expected = [await writeGameFile(pack, "pack bytes"), await writeGameFile(font, "font bytes")];
    const options = { installationRoot: installRoot, userDataDirectory: userData, expected };
    await measureInstallation(options);
    reads.length = 0;
    return { expected, options };
  }

  it("reads an unchanged archive only once, and every other declared file each time", async () => {
    const { options } = await measuredTwice();
    await measureInstallation(options);
    expect(readCount(pack)).toBe(0);
    expect(readCount(font)).toBe(1);
  });

  it("reads an archive again when its size changed, even with the same timestamp", async () => {
    const { options } = await measuredTwice();
    const absolute = join(installRoot, ...pack.split("/"));
    await writeFile(absolute, "pack bytes, longer", "utf8");
    await utimes(absolute, 1_700_000_000, 1_700_000_000);
    await measureInstallation(options);
    expect(readCount(pack)).toBe(1);
  });

  it("reads an archive again when its timestamp changed, even with the same size", async () => {
    const { options } = await measuredTwice();
    await utimes(join(installRoot, ...pack.split("/")), 1_700_000_100, 1_700_000_100);
    await measureInstallation(options);
    expect(readCount(pack)).toBe(1);
  });
});

describe("a game file held by another program", () => {
  const pack = "Resources/Assets/assets_x64_0.pack2";
  const other = "Resources/Assets/assets_x64_1.pack2";

  it("waits for a file that is busy for a moment instead of failing the launch", async () => {
    const expected = [await writeGameFile(pack, "pack bytes")];
    failures.set(join(...pack.split("/")), ["EBUSY", "EBUSY"]);
    const measurement = await measureInstallation({ installationRoot: installRoot, userDataDirectory: userData, expected });
    expect(measurement.deviations).toEqual([]);
    expect(readCount(pack)).toBe(3);
  });

  it("keeps the digests already computed when a later file cannot be read", async () => {
    const expected = [await writeGameFile(pack, "pack bytes"), await writeGameFile(other, "other bytes")];
    const options = { installationRoot: installRoot, userDataDirectory: userData, expected };
    failures.set(join(...other.split("/")), ["EIO"]);
    await expect(measureInstallation(options)).rejects.toMatchObject({ code: "EIO" });
    reads.length = 0;
    await measureInstallation(options);
    expect(readCount(pack)).toBe(0);
    expect(readCount(other)).toBe(1);
  });
});
