import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { retryFs } from "./fs-safe.js";
import { join } from "node:path";
import { elements, attribute, replaceBody } from "./interface-input-profile.js";

export interface StanceProfileState { added: string[]; removedNetworkN: boolean; }
const defaults = { ToggleWeaponStance: "V", ROTKConsole: "N" };
/** Pinned per release; the prepared rollback build sets this to false. */
export const WEAPON_STANCE_ENABLED = true;

/** Preserve every existing binding and leave ToggleDebugConsole unmodified. */
export function migrateStanceProfile(source: string, enabled: boolean,
  previous: StanceProfileState = { added: [], removedNetworkN: false },
): { text: string; state: StanceProfileState } {
  const generic = elements(source, "ActionSet").find(e => attribute(e.opening, "name") === "Generic");
  if (!generic) throw new Error("Profil de touches invalide : Generic absent.");
  let body = generic.body;
  const state = { added: [...previous.added], removedNetworkN: previous.removedNetworkN };
  const find = (name: string) => elements(body, "Action").find(e => attribute(e.opening, "name") === name);
  if (enabled) {
    for (const [name, key] of Object.entries(defaults)) {
      if (find(name)) continue;
      body += `\n    <Action name="${name}" version="1"><Trigger>${key}</Trigger></Action>\n`;
      if (!state.added.includes(name)) state.added.push(name);
    }
    const console = find("ROTKConsole")!;
    const network = find("ToggleNetworkStats");
    if (network && elements(console.body, "Trigger").some(t => t.body.trim() === "N")) {
      let replacement = network.text;
      for (const trigger of elements(network.text, "Trigger").reverse()) {
        if (trigger.body.trim() !== "N") continue;
        replacement = replacement.slice(0, trigger.start) + replacement.slice(trigger.end);
        state.removedNetworkN = true;
      }
      body = body.slice(0, network.start) + replacement + body.slice(network.end);
    }
  } else {
    for (const action of elements(body, "Action").reverse()) {
      if (state.added.includes(attribute(action.opening, "name") ?? ""))
        body = body.slice(0, action.start) + body.slice(action.end);
    }
    const network = find("ToggleNetworkStats");
    // Restore only our removed shortcut and do not disturb a subsequent rebind.
    if (state.removedNetworkN && network && elements(network.body, "Trigger").length === 0) {
      const replacement = network.opening.replace(/\/\s*>$/, ">") + "<Trigger>N</Trigger></Action>";
      body = body.slice(0, network.start) + replacement + body.slice(network.end);
    }
    state.added = []; state.removedNetworkN = false;
  }
  return { text: source.slice(0, generic.start) + replaceBody(generic, body) + source.slice(generic.end), state };
}

export async function prepareWeaponStanceProfile(root: string, stateRoot: string, enabled = true): Promise<void> {
  const profile = join(root, "InputProfile_User.xml"), stateFile = join(stateRoot, "weapon-stance.v1.json");
  const source = await readFile(profile, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  // A first launch inherits both actions from the attested Default profile.
  // Record ownership before the game serializes User, so rollback can remove
  // those actions on installations that had no user profile before this update.
  if (source === null) {
    if (enabled) {
      await mkdir(stateRoot, { recursive: true });
      await writeFile(stateFile, JSON.stringify({ added: Object.keys(defaults), removedNetworkN: false }), { flag: "wx" })
        .catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    }
    return;
  }
  let previous: StanceProfileState | undefined;
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8")) as StanceProfileState;
    if (!Array.isArray(value.added) || !value.added.every(v => Object.hasOwn(defaults, v)) || typeof value.removedNetworkN !== "boolean")
      throw new Error("Sauvegarde des touches Weapon Stance invalide.");
    previous = value;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const result = migrateStanceProfile(source, enabled, previous);
  await mkdir(stateRoot, { recursive: true });
  await copyFile(profile, join(stateRoot, "InputProfile_User.before-stance.xml"), constants.COPYFILE_EXCL)
    .catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  // Acquisition records ownership first; rollback releases it only after the
  // profile is restored. A crash between either pair remains retryable.
  const writes = [[stateFile, JSON.stringify(result.state)], [profile, result.text]];
  for (const [path, text] of enabled ? writes : writes.reverse()) {
    const temporary = `${path}.stance-${process.pid}.tmp`;
    try { await writeFile(temporary, text!, "utf8"); await retryFs(() => rename(temporary, path!)); }
    finally { await rm(temporary, { force: true }); }
  }
}
