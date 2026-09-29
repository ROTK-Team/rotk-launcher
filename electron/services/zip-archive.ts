import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createInflateRaw } from "node:zlib";

/**
 * Strict minimal ZIP reader for ROTK asset packs. The launcher controls the
 * publishing side, so anything beyond plain store/deflate central-directory
 * archives (zip64, encryption, unusual name encodings) is rejected instead of
 * supported. Entry payload integrity is guaranteed upstream by the SHA-256 of
 * the whole pack, checked before extraction.
 */

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipArchiveError";
  }
}

export interface ZipFileEntry {
  /** Validated relative entry name using `/` separators. */
  name: string;
  directory: boolean;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipDirectoryLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_EOCD_SEARCH = 64 * 1024 + EOCD_MIN_SIZE;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_NAME_LENGTH = 512;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001 | 0x0040;
const FLAG_UTF8 = 0x0800;
// Every general-purpose flag other than UTF-8 names and the benign data
// descriptor bit (sizes are read from the central directory) is rejected.
const FLAG_ALLOWED = FLAG_UTF8 | 0x0008 | 0x0002 | 0x0004;

function invalid(reason: string): ZipArchiveError {
  return new ZipArchiveError(`Archive d’assets invalide : ${reason}.`);
}

function validateEntryName(raw: Buffer): string {
  if (raw.length === 0 || raw.length > MAX_ENTRY_NAME_LENGTH) {
    throw invalid("nom d’entrée vide ou trop long");
  }
  const name = raw.toString("utf8");
  if (name.includes("\\") || name.includes("\0") || name.includes(":")) {
    throw invalid(`nom d’entrée interdit (${name.slice(0, 80)})`);
  }
  for (const char of name) {
    if (char.codePointAt(0)! < 0x20) throw invalid("nom d’entrée avec caractère de contrôle");
  }
  if (name.startsWith("/")) throw invalid(`chemin absolu (${name.slice(0, 80)})`);
  const segments = name.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) throw invalid("nom d’entrée vide");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw invalid(`traversée de dossier (${name.slice(0, 80)})`);
    }
  }
  return name;
}

export async function readZipDirectory(
  filePath: string,
  limits: ZipDirectoryLimits,
): Promise<ZipFileEntry[]> {
  const handle = await open(filePath, "r");
  try {
    const fileSize = (await handle.stat()).size;
    if (fileSize < EOCD_MIN_SIZE) throw invalid("archive tronquée");

    const searchLength = Math.min(fileSize, MAX_EOCD_SEARCH);
    const tail = Buffer.alloc(searchLength);
    await handle.read(tail, 0, searchLength, fileSize - searchLength);

    let eocdOffset = -1;
    for (let cursor = searchLength - EOCD_MIN_SIZE; cursor >= 0; cursor -= 1) {
      if (tail.readUInt32LE(cursor) === EOCD_SIGNATURE) {
        eocdOffset = cursor;
        break;
      }
    }
    if (eocdOffset === -1) throw invalid("fin de répertoire central introuvable");

    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const directorySize = tail.readUInt32LE(eocdOffset + 12);
    const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (diskNumber !== 0) throw invalid("archive multi-volume");
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw invalid("format zip64 non pris en charge");
    }
    if (entryCount > limits.maxEntries) throw invalid("trop d’entrées");
    if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) throw invalid("répertoire central trop volumineux");
    if (directoryOffset + directorySize > fileSize) throw invalid("répertoire central hors de l’archive");

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const entries: ZipFileEntry[] = [];
    let totalUncompressedBytes = 0;
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directorySize) throw invalid("répertoire central tronqué");
      if (directory.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
        throw invalid("signature de répertoire central inattendue");
      }
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localHeaderOffset = directory.readUInt32LE(cursor + 42);
      if (cursor + 46 + nameLength + extraLength + commentLength > directorySize) {
        throw invalid("répertoire central tronqué");
      }
      if ((flags & FLAG_ENCRYPTED) !== 0) throw invalid("archive chiffrée");
      if ((flags & ~FLAG_ALLOWED) !== 0) throw invalid("options zip non prises en charge");
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
        throw invalid("méthode de compression non prise en charge");
      }
      if (
        compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff
        || localHeaderOffset === 0xffffffff
      ) {
        throw invalid("format zip64 non pris en charge");
      }

      const name = validateEntryName(directory.subarray(cursor + 46, cursor + 46 + nameLength));
      const directoryEntry = name.endsWith("/");
      if (!directoryEntry) {
        if (uncompressedSize > limits.maxEntryUncompressedBytes) {
          throw invalid(`entrée trop volumineuse (${name.slice(0, 80)})`);
        }
        totalUncompressedBytes += uncompressedSize;
        if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
          throw invalid("taille décompressée totale trop grande");
        }
        if (method === METHOD_STORE && compressedSize !== uncompressedSize) {
          throw invalid(`tailles incohérentes (${name.slice(0, 80)})`);
        }
      } else if (uncompressedSize !== 0 || compressedSize !== 0) {
        throw invalid(`dossier avec contenu (${name.slice(0, 80)})`);
      }
      if (localHeaderOffset + 30 > fileSize) throw invalid("entrée hors de l’archive");

      entries.push({
        name,
        directory: directoryEntry,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Extract a single entry to `targetPath`. The target is created exclusively
 * (`wx`): callers stage into a fresh file and rename into place themselves.
 * The declared uncompressed size is a hard bound during inflation.
 */
export async function extractZipEntry(
  filePath: string,
  entry: ZipFileEntry,
  targetPath: string,
): Promise<string> {
  if (entry.directory) throw invalid("extraction d’un dossier");

  const handle = await open(filePath, "r");
  let dataStart: number;
  try {
    const fileSize = (await handle.stat()).size;
    const localHeader = Buffer.alloc(30);
    await handle.read(localHeader, 0, 30, entry.localHeaderOffset);
    if (localHeader.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw invalid("signature d’entrée locale inattendue");
    }
    const nameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataStart + entry.compressedSize > fileSize) throw invalid("entrée hors de l’archive");
  } finally {
    await handle.close();
  }

  await mkdir(dirname(targetPath), { recursive: true });
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0) throw invalid(`entrée plus petite qu’annoncé (${entry.name.slice(0, 80)})`);
    await pipeline([], createWriteStream(targetPath, { flags: "wx" }));
    return createHash("sha256").digest("hex");
  }
  let producedBytes = 0;
  const hash = createHash("sha256");
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      producedBytes += chunk.byteLength;
      if (producedBytes > entry.uncompressedSize) {
        callback(invalid(`entrée plus grande qu’annoncé (${entry.name.slice(0, 80)})`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  const source = createReadStream(filePath, {
    start: dataStart,
    end: dataStart + entry.compressedSize - 1,
  });
  const target = createWriteStream(targetPath, { flags: "wx" });
  if (entry.method === METHOD_DEFLATE) {
    await pipeline(source, createInflateRaw(), sizeGuard, target);
  } else {
    await pipeline(source, sizeGuard, target);
  }
  if (producedBytes !== entry.uncompressedSize) {
    throw invalid(`entrée plus petite qu’annoncé (${entry.name.slice(0, 80)})`);
  }
  const written = await stat(targetPath);
  if (!written.isFile() || written.size !== entry.uncompressedSize) {
    throw invalid(`écriture incomplète (${entry.name.slice(0, 80)})`);
  }
  // Digest of the successfully written stream, not an independent disk read.
  // Verify files and launch attestation retain their own integrity checks.
  return hash.digest("hex");
}

export const zipArchiveInternals = {
  validateEntryName,
};
