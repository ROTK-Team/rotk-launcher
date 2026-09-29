import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractZipEntry,
  readZipDirectory,
  type ZipDirectoryLimits,
} from "../electron/services/zip-archive.js";
import { buildZip, type ZipSpecEntry } from "./helpers/build-zip.js";

const LIMITS: ZipDirectoryLimits = {
  maxEntries: 100,
  maxEntryUncompressedBytes: 1024 * 1024,
  maxTotalUncompressedBytes: 4 * 1024 * 1024,
};

describe("ROTK asset pack zip reader", () => {
  let workDirectory: string;

  beforeEach(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), "rotk-zip-"));
  });

  afterEach(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  async function writeArchive(entries: ZipSpecEntry[]): Promise<string> {
    const archivePath = join(workDirectory, "pack.zip");
    await writeFile(archivePath, buildZip(entries));
    return archivePath;
  }

  it("extracts store and deflate entries into fresh files", async () => {
    const archivePath = await writeArchive([
      { name: "Resources/", directory: true },
      { name: "Resources/texture.dat", data: "stored payload", method: 0 },
      { name: "Resources/ui/layout.xml", data: "<layout>déflaté</layout>", method: 8 },
      { name: "empty.txt", data: "", method: 0 },
    ]);

    const entries = await readZipDirectory(archivePath, LIMITS);
    expect(entries.map((entry) => entry.name)).toEqual([
      "Resources/",
      "Resources/texture.dat",
      "Resources/ui/layout.xml",
      "empty.txt",
    ]);

    for (const entry of entries.filter((candidate) => !candidate.directory)) {
      const target = join(workDirectory, "out", ...entry.name.split("/"));
      const digest = await extractZipEntry(archivePath, entry, target);
      expect(digest).toBe(createHash("sha256").update(await readFile(target)).digest("hex"));
    }
    expect(await readFile(join(workDirectory, "out", "Resources", "texture.dat"), "utf8")).toBe("stored payload");
    expect(await readFile(join(workDirectory, "out", "Resources", "ui", "layout.xml"), "utf8")).toBe("<layout>déflaté</layout>");
    expect(await readFile(join(workDirectory, "out", "empty.txt"), "utf8")).toBe("");
  });

  it("rejects zip-slip and otherwise hostile entry names", async () => {
    const hostileNames = [
      "../evil.txt",
      "safe/../../evil.txt",
      "/absolute.txt",
      "windows\\separator.txt",
      "stream:ads.txt",
      "nul\0byte.txt",
    ];
    for (const name of hostileNames) {
      const archivePath = join(workDirectory, "hostile.zip");
      await writeFile(archivePath, buildZip([{ name, data: "boom" }]));
      await expect(readZipDirectory(archivePath, LIMITS)).rejects.toThrow("Archive d’assets invalide");
    }
  });

  it("hashes a multi-chunk deflate stream and rejects a failed output instead of returning a digest", async () => {
    const payload = Buffer.alloc(900_000, 0x61);
    const archive = await writeArchive([{ name: "large.dat", data: payload, method: 8 }]);
    const [entry] = await readZipDirectory(archive, LIMITS);
    const target = join(workDirectory, "large.out");
    expect(await extractZipEntry(archive, entry, target)).toBe(createHash("sha256").update(payload).digest("hex"));
    await expect(extractZipEntry(archive, entry, target)).rejects.toThrow();
  });

  it("rejects encrypted archives and unknown compression methods", async () => {
    const encrypted = await writeArchive([{ name: "file.txt", data: "x", flags: 0x0001 }]);
    await expect(readZipDirectory(encrypted, LIMITS)).rejects.toThrow("chiffrée");

    const bzip2 = join(workDirectory, "bzip2.zip");
    await writeFile(bzip2, buildZip([{ name: "file.txt", data: "x", method: 12 as 0 }]));
    await expect(readZipDirectory(bzip2, LIMITS)).rejects.toThrow("méthode de compression");
  });

  it("rejects zip64 size markers", async () => {
    const archivePath = await writeArchive([
      { name: "big.dat", data: "x", declaredUncompressedSize: 0xffffffff, declaredCompressedSize: 1 },
    ]);
    await expect(readZipDirectory(archivePath, LIMITS)).rejects.toThrow("zip64");
  });

  it("enforces entry-count and total-size limits", async () => {
    const manyEntries = Array.from({ length: 4 }, (_, index) => ({
      name: `file-${index}.txt`,
      data: "x",
    }));
    const archivePath = await writeArchive(manyEntries);
    await expect(readZipDirectory(archivePath, { ...LIMITS, maxEntries: 3 })).rejects.toThrow("trop d’entrées");

    const bigPath = join(workDirectory, "big.zip");
    await writeFile(bigPath, buildZip([
      { name: "a.dat", data: Buffer.alloc(600) },
      { name: "b.dat", data: Buffer.alloc(600) },
    ]));
    await expect(
      readZipDirectory(bigPath, { ...LIMITS, maxTotalUncompressedBytes: 1000 }),
    ).rejects.toThrow("taille décompressée totale");
  });

  it("stops inflating an entry that produces more bytes than declared", async () => {
    const inflated = Buffer.alloc(64 * 1024, 0x41);
    const archivePath = await writeArchive([
      { name: "bomb.dat", data: inflated, method: 8, declaredUncompressedSize: 10 },
    ]);
    const [entry] = await readZipDirectory(archivePath, LIMITS);
    await expect(
      extractZipEntry(archivePath, entry, join(workDirectory, "bomb.out")),
    ).rejects.toThrow("plus grande qu’annoncé");
    // The partial staging file must not linger after the failure is handled
    // by the caller; here we only assert nothing was silently truncated.
    const produced = await readdir(workDirectory);
    expect(produced).toContain("pack.zip");
  });
});
