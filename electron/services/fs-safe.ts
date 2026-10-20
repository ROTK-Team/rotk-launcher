import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, open, rename, rm, stat } from "node:fs/promises";

// Antivirus, indexer and sync clients hold freshly written files for a moment,
// so rename/replace/delete can fail with EPERM/EBUSY/EACCES. Retry those.
// EPERM/EACCES are also real permission errors, so they get a shorter budget.
const TRANSIENT_WAIT_MS: Record<string, number> = { EBUSY: 7_500, EPERM: 1_500, EACCES: 1_500 };

export interface RetryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// About 7 s of waiting for EBUSY, 1.5 s for EPERM/EACCES with the defaults.
export async function retryFs<T>(
  operation: () => Promise<T>,
  { baseDelayMs = 100, maxDelayMs = 2_000 }: RetryOptions = {},
): Promise<T> {
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const budget = TRANSIENT_WAIT_MS[(error as NodeJS.ErrnoException).code ?? ""];
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      if (budget === undefined || waited + delay > budget) throw error;
      waited += delay;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
}

export interface DurableWriteOptions {
  encoding?: BufferEncoding;
  flag?: string;
  mode?: number;
}

// NTFS can commit a rename and the new file size before the data itself: after
// a power cut or a BSOD the file then has the right size and only NUL bytes.
// Flush the data (FlushFileBuffers) before renaming it over the old file.
export async function writeFileDurably(
  path: string,
  contents: string,
  { encoding = "utf8", flag = "w", mode }: DurableWriteOptions = {},
): Promise<void> {
  const handle = await open(path, flag, mode);
  try {
    await handle.writeFile(contents, { encoding });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush a file written by something else (copyFile, a stream) to the disk. */
export async function syncFile(path: string): Promise<void> {
  // FlushFileBuffers needs a handle with write access. copyFile carries the
  // read-only attribute over to the copy (a locked ClientConfig.ini, say), and
  // that copy cannot be opened for writing: skip the flush for it, as before.
  const handle = await retryFs(async () => {
    try {
      return await open(path, "r+");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const details = code === "EPERM" || code === "EACCES" ? await stat(path).catch(() => null) : null;
      if (details && (details.mode & 0o200) === 0) return null;
      throw error;
    }
  });
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicCopyFile(source: string, target: string): Promise<void> {
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  try {
    await retryFs(async () => {
      await rm(temporary, { force: true });
      await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    });
    await syncFile(temporary);
    await retryFs(() => rename(temporary, target));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteFile(
  target: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
  { mode }: { mode?: number } = {},
): Promise<void> {
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  try {
    await writeFileDurably(temporary, contents, { encoding, flag: "wx", mode });
    await retryFs(() => rename(temporary, target));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
