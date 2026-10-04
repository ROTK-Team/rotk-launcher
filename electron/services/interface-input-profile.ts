import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { retryFs } from "./fs-safe.js";
import { join } from "node:path";

const ACTIONS = new Set(["OpenMap", "ToggleInventory"]);
type ManagedTriggers = Record<string, string[]>;

interface Element {
  start: number;
  end: number;
  opening: string;
  body: string;
  text: string;
}

// Keep offsets and original bytes: the client owns the rest of this document.
export function elements(source: string, tag: string): Element[] {
  const pattern = new RegExp(
    `<!--[\\s\\S]*?-->|<${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "g",
  );
  const result: Element[] = [];
  for (let match; (match = pattern.exec(source));) {
    const opening = match[0];
    if (opening.startsWith("<!--")) continue;
    const bodyStart = pattern.lastIndex;
    const selfClosing = /\/\s*>$/.test(opening);
    const closing = new RegExp(`</${tag}\\s*>`, "g");
    closing.lastIndex = bodyStart;
    const close = selfClosing ? null : closing.exec(source);
    if (!selfClosing && !close) throw new Error(`Invalid input profile: unclosed ${tag}`);
    const end = selfClosing ? bodyStart : closing.lastIndex;
    result.push({ start: match.index, end, opening,
      body: selfClosing ? "" : source.slice(bodyStart, close!.index),
      text: source.slice(match.index, end) });
    pattern.lastIndex = end;
  }
  return result;
}

export function attribute(opening: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`).exec(opening)?.[2];
}

function actions(source: string): Map<string, Element> {
  const result = new Map<string, Element>();
  for (const set of elements(source, "ActionSet")) {
    for (const action of elements(set.body, "Action")) {
      result.set(`${attribute(set.opening, "name")}/${attribute(action.opening, "name")}`, action);
    }
  }
  return result;
}

function triggers(action: Element): string[] {
  return elements(action.body, "Trigger").map(trigger => trigger.body.trim());
}

function normalizedTrigger(trigger: string): string {
  return trigger.toLowerCase().replace(/\b(shift|control|alt)_(left|right)\b/g, "$1");
}

export function replaceBody(element: Element, body: string): string {
  if (/\/\s*>$/.test(element.opening)) {
    return element.opening.replace(/\/\s*>$/, ">") + body + "</ActionSet>";
  }
  return element.opening + body + element.text.slice(element.opening.length + element.body.length);
}

/** Add only Shift variants, leaving Ctrl/Alt shortcuts and explicit chords intact. */
export function synchronizeInterfaceInputProfile(
  userSource: string | null,
  defaultSource: string,
  previous: ManagedTriggers = {},
): { text: string; managed: ManagedTriggers } {
  const source = userSource ?? defaultSource.replace(
    /(<Profile\b[^>]*\bname\s*=\s*)(["'])Default\2/, "$1$2User$2",
  );
  if (!/<\/Profile\s*>/.test(source)) throw new Error("Invalid input profile: missing Profile end");
  const defaults = actions(defaultSource);
  const sets = elements(source, "ActionSet");
  const generic = sets.find(set => attribute(set.opening, "name") === "Generic");
  let body = generic?.body ?? "";

  // A user profile may omit actions which still inherit their default bindings.
  for (const name of ACTIONS) {
    const current = elements(body, "Action").find(action => attribute(action.opening, "name") === name);
    if (!current) {
      const inherited = defaults.get(`Generic/${name}`);
      if (inherited) body += `\n    ${inherited.text}\n`;
    }
  }

  // The game serializes XML again, losing comments/attributes on triggers. Keep
  // ownership outside the game folder so remapping a key retires its old alias.
  for (const action of elements(body, "Action").reverse()) {
    const name = attribute(action.opening, "name")!;
    if (!ACTIONS.has(name)) continue;
    const owned = new Set(previous[name] ?? []);
    let cleaned = action.text;
    for (const trigger of elements(action.text, "Trigger").reverse()) {
      if (owned.has(trigger.body.trim())) {
        cleaned = cleaned.slice(0, trigger.start) + cleaned.slice(trigger.end);
      }
    }
    body = body.slice(0, action.start) + cleaned + body.slice(action.end);
  }

  function withBody(updated: string): string {
    if (generic) return source.slice(0, generic.start) + replaceBody(generic, updated) + source.slice(generic.end);
    return source.replace(/<\/Profile\s*>/, `<ActionSet name="Generic">${updated}</ActionSet>\n$&`);
  }
  const effective = new Map([...defaults, ...actions(withBody(body))]);
  const occupied = new Map<string, Set<string>>();
  for (const [id, action] of effective) {
    for (const trigger of triggers(action)) {
      const key = normalizedTrigger(trigger);
      const owners = occupied.get(key) ?? new Set<string>();
      owners.add(id);
      occupied.set(key, owners);
    }
  }
  const managed: ManagedTriggers = {};
  for (const action of elements(body, "Action").reverse()) {
    const name = attribute(action.opening, "name")!;
    if (!ACTIONS.has(name)) continue;
    const added: string[] = [];
    for (const trigger of triggers(action)) {
      if (!/^[A-Za-z0-9_]+$/.test(trigger) || /^(Gamepad|Joystick|Shift|Control|Alt)(?:_|$)/i.test(trigger)) continue;
      const alias = `Shift+${trigger}`;
      const key = normalizedTrigger(alias);
      if (occupied.has(key)) continue;
      added.push(alias);
      occupied.set(key, new Set([`Generic/${name}`]));
    }
    if (added.length === 0) continue;
    managed[name] = added;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const indentation = /(?:^|\n)([ \t]*)<Trigger\b/.exec(action.body)?.[1] ?? "      ";
    const text = action.text.replace(/<\/Action\s*>$/, added.map(alias =>
      `${newline}${indentation}<Trigger>${alias}</Trigger>`).join("") + `${newline}    </Action>`);
    body = body.slice(0, action.start) + text + body.slice(action.end);
  }
  const updated = withBody(body);
  // Removing/re-adding our aliases must not accumulate whitespace on every launch.
  const text = updated.replace(/>\s+</g, "><") === source.replace(/>\s+</g, "><") ? source : updated;
  return { text, managed };
}

async function optionalRead(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.rotk-tmp-${process.pid}`;
  try { await writeFile(temporary, contents, "utf8"); await retryFs(() => rename(temporary, path)); }
  finally { await rm(temporary, { force: true }); }
}

function readManagedTriggers(saved: string | null): ManagedTriggers {
  if (saved === null) return {};
  try {
    const value: unknown = JSON.parse(saved);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const result: ManagedTriggers = {};
    for (const [name, triggers] of Object.entries(value)) {
      if (ACTIONS.has(name) && Array.isArray(triggers) && triggers.every(trigger =>
        typeof trigger === "string" && /^Shift\+[A-Za-z0-9_]+$/.test(trigger))) result[name] = triggers;
    }
    return result;
  } catch { return {}; }
}

export async function prepareInterfaceInputProfile(root: string, stateRoot: string): Promise<void> {
  const defaults = await optionalRead(join(root, "InputProfile_Default.xml"));
  if (defaults === null) return;
  const profilePath = join(root, "InputProfile_User.xml");
  const source = await optionalRead(profilePath);
  const statePath = join(stateRoot, "shift-interface-shortcuts.json");
  const saved = await optionalRead(statePath);
  const previous = readManagedTriggers(saved);
  const result = synchronizeInterfaceInputProfile(source, defaults, previous);
  await mkdir(stateRoot, { recursive: true });
  if (source !== null && result.text !== source) {
    await copyFile(profilePath, join(stateRoot, "InputProfile_User.before-shift.xml"), constants.COPYFILE_EXCL)
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
  if (result.text !== source) await atomicWrite(profilePath, result.text);
  const state = JSON.stringify(result.managed, null, 2) + "\n";
  if (state !== saved) await atomicWrite(statePath, state);
}
