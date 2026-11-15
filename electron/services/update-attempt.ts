import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./fs-safe.js";

const ATTEMPT_FILE_NAME = "launcher-update-attempt.v1.json";
/**
 * The installer replaces the launcher within seconds. A launcher started again
 * sooner than this may still be the old one waiting to be replaced, so the
 * attempt is not judged yet.
 */
const INSTALLER_GRACE_MS = 60_000;

interface UpdateAttempt {
  from: string;
  to: string;
  at: number;
}

function isUpdateAttempt(value: unknown): value is UpdateAttempt {
  const attempt = value as Partial<UpdateAttempt> | null;
  return Boolean(attempt) && typeof attempt?.from === "string" && typeof attempt.to === "string"
    && typeof attempt.at === "number";
}

/** Written just before the launcher quits to let the installer run. */
export async function recordUpdateAttempt(
  userDataDirectory: string,
  fromVersion: string,
  toVersion: string,
  now = Date.now(),
): Promise<void> {
  const attempt: UpdateAttempt = { from: fromVersion, to: toVersion, at: now };
  await atomicWriteFile(join(userDataDirectory, ATTEMPT_FILE_NAME), JSON.stringify(attempt));
}

export async function clearUpdateAttempt(userDataDirectory: string): Promise<void> {
  await rm(join(userDataDirectory, ATTEMPT_FILE_NAME), { force: true });
}

/**
 * The version of an update that was started and did not install: the launcher
 * that runs now is still the one that started it. Null when there was no
 * attempt, when it worked, or when it is too recent to tell.
 *
 * The launcher quits for the installer whatever happens next. When Windows or
 * an antivirus blocked the unsigned installer, the launcher simply closed,
 * reopened in the same version and offered the same update again, with
 * nothing to say why.
 */
export async function failedUpdateAttempt(
  userDataDirectory: string,
  currentVersion: string,
  now = Date.now(),
): Promise<string | null> {
  let attempt: unknown;
  try {
    attempt = JSON.parse(await readFile(join(userDataDirectory, ATTEMPT_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
  if (!isUpdateAttempt(attempt)) {
    await clearUpdateAttempt(userDataDirectory).catch(() => undefined);
    return null;
  }
  if (attempt.from === currentVersion && now - attempt.at < INSTALLER_GRACE_MS) return null;
  await clearUpdateAttempt(userDataDirectory).catch(() => undefined);
  return attempt.from === currentVersion ? attempt.to : null;
}
