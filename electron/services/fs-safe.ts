import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";

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

export async function atomicCopyFile(source: string, target: string): Promise<void> {
  const temporary = `${target}.rotk-${randomUUID()}.tmp`;
  try {
    await retryFs(async () => {
      await rm(temporary, { force: true });
      await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    });
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
