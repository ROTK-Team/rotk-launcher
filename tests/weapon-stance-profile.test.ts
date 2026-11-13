import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateStanceProfile, prepareWeaponStanceProfile } from "../electron/services/weapon-stance-profile.js";
const source = '<Profile name="User"><ActionSet name="Generic"><Action name="ToggleDebugConsole" unbindable="true"><Trigger>Tilde</Trigger></Action><Action name="OpenMap"><Trigger>M</Trigger></Action><Action name="ToggleNetworkStats"><Trigger>N</Trigger></Action></ActionSet><ActionSet name="Infantry"><Action name="Sprint"><Trigger>Shift</Trigger></Action></ActionSet></Profile>';
describe("stance binding migration and rollback", () => {
  it("records ownership on first launch and removes inherited actions on rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "rotk-stance-first-"));
    const state = join(root, "state");
    try {
      await prepareWeaponStanceProfile(root, state, true);
      const inherited = migrateStanceProfile(source, true).text;
      await writeFile(join(root, "InputProfile_User.xml"), inherited);
      await prepareWeaponStanceProfile(root, state, false);
      const restored = await readFile(join(root, "InputProfile_User.xml"), "utf8");
      expect(restored).not.toContain('name="ToggleWeaponStance"');
      expect(restored).not.toContain('name="ROTKConsole"');
      expect(restored).toContain('<Trigger>M</Trigger>');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not rewrite a profile and an ownership file that are already right", async () => {
    const root = await mkdtemp(join(tmpdir(), "rotk-stance-unchanged-"));
    const state = join(root, "state");
    const profile = join(root, "InputProfile_User.xml"), ownership = join(state, "weapon-stance.v1.json");
    try {
      await writeFile(profile, source);
      await prepareWeaponStanceProfile(root, state, true);
      const text = await readFile(profile, "utf8");
      expect(text).toContain('name="ToggleWeaponStance"');
      const before = new Date("2020-01-01T00:00:00Z");
      await utimes(profile, before, before); await utimes(ownership, before, before);
      await prepareWeaponStanceProfile(root, state, true);
      expect(await readFile(profile, "utf8")).toBe(text);
      expect((await stat(profile)).mtimeMs).toBe(before.getTime());
      expect((await stat(ownership)).mtimeMs).toBe(before.getTime());
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("ignores invalid ownership without touching the player's bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "rotk-stance-state-"));
    const state = join(root, "state");
    try {
      await mkdir(state); await writeFile(join(root, "InputProfile_User.xml"), source);
      const invalid = JSON.stringify({ added: ["OpenMap"], removedNetworkN: true });
      await writeFile(join(state, "weapon-stance.v1.json"), invalid);
      await prepareWeaponStanceProfile(root, state, false);
      expect(await readFile(join(root, "InputProfile_User.xml"), "utf8")).toBe(source);
      expect(await readFile(join(state, "weapon-stance.v1.json.corrupt"), "utf8")).toBe(invalid);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["", "{\"added\":[\"Toggle", "null"])("recovers from an unreadable ownership file (%j)", async broken => {
    const root = await mkdtemp(join(tmpdir(), "rotk-stance-state-"));
    const state = join(root, "state");
    try {
      await mkdir(state); await writeFile(join(root, "InputProfile_User.xml"), source);
      await writeFile(join(state, "weapon-stance.v1.json"), broken);
      // A copy set aside by an earlier recovery must not block this one.
      await writeFile(join(state, "weapon-stance.v1.json.corrupt"), "older");
      await prepareWeaponStanceProfile(root, state, true);
      expect(await readFile(join(root, "InputProfile_User.xml"), "utf8")).toContain('<Action name="ToggleWeaponStance" version="1"><Trigger>V</Trigger></Action>');
      expect(JSON.parse(await readFile(join(state, "weapon-stance.v1.json"), "utf8"))).toEqual({ added: ["ToggleWeaponStance"], removedNetworkN: false });
      expect(await readFile(join(state, "weapon-stance.v1.json.corrupt"), "utf8")).toBe(broken);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps the stock console and unrelated bindings intact", () => {
    const next = migrateStanceProfile(source, true);
    expect(next.text).toContain('<Action name="ToggleDebugConsole" unbindable="true"><Trigger>Tilde</Trigger></Action>');
    expect(next.text).toContain('<Action name="ToggleNetworkStats"><Trigger>N</Trigger></Action>');
    expect(next.text).toContain('<Action name="OpenMap"><Trigger>M</Trigger></Action>');
    expect(next.text).toContain('<Action name="Sprint"><Trigger>Shift</Trigger></Action>');
    expect(next.text).not.toContain('ROTKConsole');
    expect(next.state).toEqual({ added: ["ToggleWeaponStance"], removedNetworkN: false });
    expect(migrateStanceProfile(next.text,true,next.state)).toEqual(next);
  });
  it("creates Generic when an interrupted user profile omitted it", () => {
    const partial = '<Profile name="User"><ActionSet name="Infantry"><Action name="Sprint"><Trigger>Shift</Trigger></Action></ActionSet></Profile>';
    const next = migrateStanceProfile(partial, true);
    expect(next.text).toContain('<ActionSet name="Generic">');
    expect(next.text).toContain('<Action name="ToggleWeaponStance" version="1"><Trigger>V</Trigger></Action>');
    expect(next.text).toContain('<Action name="Sprint"><Trigger>Shift</Trigger></Action>');
    expect(next.text).not.toContain('ROTKConsole');
    expect(next.state).toEqual({ added: ["ToggleWeaponStance"], removedNetworkN: false });
  });
  it("preserves a custom stance shortcut", () => {
    const custom=source.replace('</ActionSet>', '<Action name="ToggleWeaponStance"><Trigger>B</Trigger></Action></ActionSet>');
    const next=migrateStanceProfile(custom,true);
    expect(next.text).toBe(custom); expect(next.state.added).toEqual([]);
  });
  it("retires the custom console action and restores only an owned network shortcut", () => {
    const legacy=source.replace('<Action name="ToggleNetworkStats"><Trigger>N</Trigger></Action>','<Action name="ToggleNetworkStats"></Action>')
      .replace('</ActionSet>', '<Action name="ToggleWeaponStance" version="1"><Trigger>V</Trigger></Action><Action name="ROTKConsole" version="1"><Trigger>N</Trigger></Action></ActionSet>');
    const state={ added: ["ToggleWeaponStance", "ROTKConsole"], removedNetworkN: true };
    const next=migrateStanceProfile(legacy,true,state);
    expect(next.text).not.toContain('ROTKConsole');
    expect(next.text).toContain('<Action name="ToggleNetworkStats"><Trigger>N</Trigger></Action>');
    expect(next.state).toEqual({ added: ["ToggleWeaponStance"], removedNetworkN: false });
    expect(migrateStanceProfile(next.text,true,next.state)).toEqual(next);
    const rebound=legacy.replace('<Action name="ToggleNetworkStats"></Action>','<Action name="ToggleNetworkStats"><Trigger>F5</Trigger></Action>');
    const kept=migrateStanceProfile(rebound,true,state).text;
    expect(kept).toContain('<Trigger>F5</Trigger>'); expect(kept).not.toContain('<Trigger>N</Trigger>');    const custom=legacy.replace('<Action name="ROTKConsole" version="1"><Trigger>N</Trigger></Action>','<Action name="ROTKConsole" version="1"><Trigger>F6</Trigger></Action>');
    expect(migrateStanceProfile(custom,true,state).text).not.toContain('name="ROTKConsole"');
  });
  it("rolls back only owned actions", () => {
    const installed=migrateStanceProfile(source,true);
    const restored=migrateStanceProfile(installed.text,false,installed.state);
    expect(restored.text.replace(/\s+/g,'')).toBe(source.replace(/\s+/g,''));
    expect(migrateStanceProfile(restored.text,false,restored.state)).toEqual(restored);
  });
  it("keeps player edits to other bindings during rollback", () => {
    const installed=migrateStanceProfile(source,true);
    const edited=installed.text.replace('<Trigger>M</Trigger>','<Trigger>J</Trigger>');
    const result=migrateStanceProfile(edited,false,installed.state);
    expect(result.text).toContain('<Trigger>J</Trigger>'); expect(result.text).not.toContain('ToggleWeaponStance');
  });
});
