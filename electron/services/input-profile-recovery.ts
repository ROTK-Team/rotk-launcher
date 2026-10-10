import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, retryFs } from "./fs-safe.js";
import { elements } from "./interface-input-profile.js";

export interface InputProfileRecovery {
  /** The last usable copy was put back; otherwise the defaults apply. */
  restored: boolean;
  /** Where the damaged profile was kept, outside the game folder. */
  damagedCopy: string;
}

/**
 * Whether both input-profile steps can parse the profile: the Profile end is
 * present and every ActionSet, Action and Trigger they read is closed. A
 * complete profile without Generic passes; the stance step adds that set.
 */
export function isUsableInputProfile(source: string): boolean {
  if (!/<\/Profile\s*>/.test(source)) return false;
  try {
    for (const set of elements(source, "ActionSet")) {
      for (const action of elements(set.body, "Action")) elements(action.body, "Trigger");
    }
    return true;
  } catch {
    return false;
  }
}

async function optionalRead(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * H1Z1 rewrites the user profile every session, so a crash or a forced
 * shutdown can leave it truncated, and the input-profile steps would then
 * refuse every launch. Keep a copy of each usable profile in the launcher
 * state, outside the attested game folder. A damaged profile is set aside
 * there too, then replaced by that copy, or removed when there is none so the
 * launch continues as a first one, from InputProfile_Default.xml.
 */
export async function recoverInputProfile(root: string, stateRoot: string): Promise<InputProfileRecovery | null> {
  const profile = join(root, "InputProfile_User.xml");
  const lastGood = join(stateRoot, "InputProfile_User.last-good.xml");
  const source = await optionalRead(profile);
  if (source === null) return null;
  if (isUsableInputProfile(source)) {
    try {
      if (await optionalRead(lastGood) !== source) {
        await mkdir(stateRoot, { recursive: true });
        await atomicWriteFile(lastGood, source);
      }
    } catch (error) {
      // Only a safety net: a copy we cannot refresh must not block Play.
      console.warn("The last usable input profile was not saved; launching anyway.", error);
    }
    return null;
  }
  await mkdir(stateRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const damagedCopy = join(stateRoot, `InputProfile_User.damaged-${stamp}.xml`);
  await copyFile(profile, damagedCopy, constants.COPYFILE_EXCL);
  const saved = await optionalRead(lastGood).catch(() => null);
  if (saved !== null && isUsableInputProfile(saved)) {
    await atomicWriteFile(profile, saved);
    return { restored: true, damagedCopy };
  }
  await retryFs(() => rm(profile, { force: true }));
  return { restored: false, damagedCopy };
}
