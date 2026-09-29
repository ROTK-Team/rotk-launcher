import { randomUUID } from "node:crypto";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";

// Antivirus, indexer and sync clients hold freshly written files for a moment,
// so rename/replace/delete can fail with EPERM/EBUSY/EACCES. Retry those.

const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// About 7 s in total with the defaults.
export async function retryFs<T>(
  operation: () => Promise<T>,
  { attempts = 8, baseDelayMs = 100, maxDelayMs = 2_000 }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_CODES.has(code) || attempt >= attempts) throw error;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)));
    }
  }
}

export async function atomicCopyFile(source: string, target: string): Promise<void> {
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  try {
    await retryFs(() => copyFile(source, temporary));
    await retryFs(() => rename(temporary, target));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteFile(
  target: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding, flag: "wx" });
    await retryFs(() => rename(temporary, target));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
