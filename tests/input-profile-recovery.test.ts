import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_COPY } from "../electron/i18n.js";
import { gameLauncherInternals, type LaunchRequest } from "../electron/services/game-launcher.js";
import { isUsableInputProfile, recoverInputProfile } from "../electron/services/input-profile-recovery.js";
import { prepareInterfaceInputProfile, synchronizeInterfaceInputProfile } from "../electron/services/interface-input-profile.js";
import type { LaunchTicketIdentity } from "../electron/services/launch-ticket.js";
import { RUNTIME_CONFIGS } from "../electron/services/runtime-config.js";
import { migrateStanceProfile, prepareWeaponStanceProfile, WEAPON_STANCE_ENABLED } from "../electron/services/weapon-stance-profile.js";
import { APP_LOCALES } from "../shared/locale.js";

vi.mock("../electron/services/vivox-client.js", () => ({ deployVivoxCompatibility: async () => undefined,
  assertVivoxCompatibility: async () => undefined }));
vi.mock("../electron/services/gameplay-patch.js", () => ({ assertGameplayPatchState: async () => undefined }));
vi.mock("../electron/services/client-config.js", () => ({ synchronizeClientConfig: (current: string) => current,
  synchronizeUserOptions: (current: string) => current, GAME_LOCALE: { en: "en_us", fr: "en_us", zh: "en_us" },
  validateLocalCreateSessionUrl: (url: string) => url }));

const defaults = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Profile name="Default" version="13">',
  '  <ActionSet name="Generic">',
  '    <Action name="OpenMap" ignoreModifiers="false" version="5"><Trigger>M</Trigger></Action>',
  '    <Action name="ToggleInventory" ignoreModifiers="false"><Trigger>Tab</Trigger></Action>',
  '    <Action name="ToggleWeaponStance" version="1"><Trigger>V</Trigger></Action>',
  "  </ActionSet>",
  '  <ActionSet name="Infantry">',
  '    <Action name="Sprint" ignoreModifiers="true"><Trigger>Shift_Left</Trigger></Action>',
  "  </ActionSet>",
  "</Profile>",
].join("\r\n");
// The game writes CRLF and the player moved OpenMap to P.
const user = [
  '<Profile name="User" version="13">',
  '    <ActionSet name="Generic" actionSetType="" radialMenuNavigation="Right">',
  '        <Action name="OpenMap" version="5">',
  "            <Trigger>P</Trigger>",
  "        </Action>",
  '        <Action name="ToggleInventory">',
  "            <Trigger>Tab</Trigger>",
  "        </Action>",
  "    </ActionSet>",
  '    <ActionSet name="Infantry">',
  '        <Action name="Sprint">',
  "            <Trigger>Shift_Left</Trigger>",
  "        </Action>",
  "    </ActionSet>",
  "</Profile>",
  "",
].join("\r\n");
const withoutGeneric = '<Profile name="User"><ActionSet name="Infantry"><Action name="Sprint"><Trigger>Shift</Trigger></Action></ActionSet></Profile>';
const damaged: Record<string, string> = {
  "truncated inside Generic": user.slice(0, user.indexOf("</ActionSet>")),
  "truncated inside a later ActionSet": user.slice(0, user.lastIndexOf("</ActionSet>")),
  "truncated between ActionSets": user.slice(0, user.indexOf('<ActionSet name="Infantry">')),
  "missing Generic and Profile end": withoutGeneric.replace("</Profile>", ""),
  "empty": "",
  "an unclosed Action": user.replace("            <Trigger>Tab</Trigger>\r\n        </Action>", "            <Trigger>Tab</Trigger>"),
  "an unclosed Trigger": user.replace("<Trigger>Tab</Trigger>", "<Trigger>Tab"),
};
const usable: Record<string, string> = {
  "a complete profile": user,
  "a complete profile without Generic": withoutGeneric,
  "an empty Profile": '<Profile name="User"></Profile>',
};

/** What prepareClient does after the recovery, without touching the disk. */
function stepsAccept(source: string): boolean {
  try {
    synchronizeInterfaceInputProfile(migrateStanceProfile(source, WEAPON_STANCE_ENABLED).text, defaults);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(join(tmpdir(), "rotk-input-recovery-")))) throw new Error("Unsafe test cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(profile?: string) {
  const parent = await mkdtemp(join(tmpdir(), "rotk-input-recovery-")); roots.push(parent);
  // The game folder and the launcher state stay separate, as in production.
  const root = join(parent, "ROTK"), logsRoot = join(parent, "userData", "logs");
  const state = join(logsRoot, "fixture", "input-profile");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "InputProfile_Default.xml"), defaults);
  if (profile !== undefined) await writeFile(join(root, "InputProfile_User.xml"), profile);
  const prepare = async () => {
    await prepareWeaponStanceProfile(root, state, WEAPON_STANCE_ENABLED);
    await prepareInterfaceInputProfile(root, state);
    return readFile(join(root, "InputProfile_User.xml"), "utf8");
  };
  return { root, logsRoot, state, profile: join(root, "InputProfile_User.xml"), lastGood: join(state, "InputProfile_User.last-good.xml"), prepare };
}

describe("input profile check", () => {
  it.each(Object.entries(damaged))("rejects a profile with %s, which the input-profile steps refuse", (_name, source) => {
    expect(isUsableInputProfile(source)).toBe(false);
    expect(stepsAccept(source)).toBe(false);
  });

  it.each(Object.entries(usable))("accepts %s, which the input-profile steps handle", (_name, source) => {
    expect(isUsableInputProfile(source)).toBe(true);
    expect(stepsAccept(source)).toBe(true);
  });

  it("catches every truncation of a profile", () => {
    for (let length = 0; length < user.trimEnd().length; length += 1) {
      const truncated = user.slice(0, length);
      expect(isUsableInputProfile(truncated), `length ${length}`).toBe(false);
      expect(stepsAccept(truncated), `length ${length}`).toBe(false);
    }
  });
});

describe("input profile recovery", () => {
  it("saves a usable profile as the last good copy without changing it", async () => {
    const f = await fixture(user);
    await expect(recoverInputProfile(f.root, f.state)).resolves.toBeNull();
    expect(await readFile(f.profile, "utf8")).toBe(user);
    expect(await readFile(f.lastGood, "utf8")).toBe(user);
    const rebound = user.replace("<Trigger>P</Trigger>", "<Trigger>J</Trigger>");
    await writeFile(f.profile, rebound);
    await expect(recoverInputProfile(f.root, f.state)).resolves.toBeNull();
    expect(await readFile(f.lastGood, "utf8")).toBe(rebound);
  });

  it("leaves a complete profile without Generic to the existing repair", async () => {
    const f = await fixture(withoutGeneric);
    await expect(recoverInputProfile(f.root, f.state)).resolves.toBeNull();
    expect(await readFile(f.profile, "utf8")).toBe(withoutGeneric);
    expect(await readFile(f.lastGood, "utf8")).toBe(withoutGeneric);
    const prepared = await f.prepare();
    expect(prepared).toContain('<ActionSet name="Generic">');
    expect(prepared).toContain('<Action name="Sprint"><Trigger>Shift</Trigger></Action>');
  });

  it.each(Object.entries(damaged))("restores the last good copy over a profile with %s", async (_name, source) => {
    const f = await fixture(user);
    await recoverInputProfile(f.root, f.state);
    await writeFile(f.profile, source);
    const recovery = await recoverInputProfile(f.root, f.state);
    expect(recovery).toEqual({ restored: true, damagedCopy: expect.stringMatching(/InputProfile_User\.damaged-.+\.xml$/) });
    expect(dirname(recovery!.damagedCopy)).toBe(f.state);
    expect(await readFile(recovery!.damagedCopy, "utf8")).toBe(source);
    expect(await readFile(f.profile, "utf8")).toBe(user);
    // Nothing is left in the game folder for the integrity check to see.
    expect((await readdir(f.root)).sort()).toEqual(["InputProfile_Default.xml", "InputProfile_User.xml"]);
    const prepared = await f.prepare();
    expect(prepared).toContain("<Trigger>P</Trigger>");
    expect(prepared).toContain("<Trigger>Shift+P</Trigger>");
  });

  it.each(Object.entries(damaged))("falls back to the defaults for a profile with %s when no copy was saved", async (_name, source) => {
    const f = await fixture(source);
    const recovery = await recoverInputProfile(f.root, f.state);
    expect(recovery).toEqual({ restored: false, damagedCopy: expect.stringMatching(/InputProfile_User\.damaged-.+\.xml$/) });
    expect(dirname(recovery!.damagedCopy)).toBe(f.state);
    expect(await readFile(recovery!.damagedCopy, "utf8")).toBe(source);
    expect((await readdir(f.root)).sort()).toEqual(["InputProfile_Default.xml"]);
    // Same as a first launch: the interface step writes User from Default.
    const prepared = await f.prepare();
    expect(prepared).toContain('<Profile name="User" version="13">');
    expect(prepared).toContain("<Trigger>V</Trigger>");
    expect(prepared).toContain("<Trigger>Shift+M</Trigger>");
    expect(prepared).not.toContain("<Trigger>P</Trigger>");
    // The next launch keeps that profile as the new last good copy.
    await expect(recoverInputProfile(f.root, f.state)).resolves.toBeNull();
    expect(await readFile(f.lastGood, "utf8")).toBe(prepared);
  });

  it("never restores a damaged last good copy", async () => {
    const f = await fixture(damaged["truncated between ActionSets"]);
    await mkdir(f.state, { recursive: true });
    await writeFile(f.lastGood, damaged["truncated inside Generic"]);
    await expect(recoverInputProfile(f.root, f.state)).resolves.toMatchObject({ restored: false });
    expect((await readdir(f.root)).sort()).toEqual(["InputProfile_Default.xml"]);
  });

  it("keeps every damaged copy", async () => {
    const f = await fixture("");
    const first = await recoverInputProfile(f.root, f.state);
    await writeFile(f.profile, damaged["truncated inside Generic"]);
    await new Promise(next => setTimeout(next, 5));
    const second = await recoverInputProfile(f.root, f.state);
    expect(second!.damagedCopy).not.toBe(first!.damagedCopy);
    expect(await readFile(first!.damagedCopy, "utf8")).toBe("");
    expect(await readFile(second!.damagedCopy, "utf8")).toBe(damaged["truncated inside Generic"]);
  });

  it("does nothing on a first launch", async () => {
    const f = await fixture();
    await expect(recoverInputProfile(f.root, f.state)).resolves.toBeNull();
    expect((await readdir(f.root)).sort()).toEqual(["InputProfile_Default.xml"]);
    expect(existsSync(f.state)).toBe(false);
  });
});

describe("client preparation", () => {
  it("recovers the profile before the input-profile steps and reports it once", async () => {
    const f = await fixture(damaged["truncated inside a later ActionSet"]);
    // steam_api64.dll already holds the bundled shim, as it does once the launch
    // path has deployed it (#135 moves that copy before attestation).
    for (const name of ["bundled-shim.dll", "bundled-rotkc.dll", "steam_api64.dll"]) await writeFile(join(f.root, name), "fixture bytes");
    await writeFile(join(f.root, "ClientConfig.ini"), "[Client]\n");
    const onInputProfileRecovered = vi.fn();
    const request: LaunchRequest = {
      config: { schemaVersion: 1, installation: { installId: "fixture", root: f.root, sourceRoot: f.root,
        clientBuildId: "fixture", installedAt: new Date().toISOString(), criticalHashes: {} } },
      identity: { playerKey: "test-only-player-key" } as LaunchRequest["identity"],
      runtime: RUNTIME_CONFIGS.test, locale: "en", logsRoot: f.logsRoot,
      bundledShimPath: join(f.root, "bundled-shim.dll"), bundledVivoxProxyPath: join(f.root, "unused-proxy.dll"),
      bundledVivoxRuntimePath: join(f.root, "unused-runtime.dll"), bundledGameplayPatchPath: join(f.root, "unused-dinput8.dll"),
      bundledRotkcPath: join(f.root, "bundled-rotkc.dll"), clientPatchModeFallback: "clean",
      onInputProfileRecovered, onExit: vi.fn(),
    };
    const identity = { ticket: "test-only-ticket", displayName: "FixturePlayer", steamId: "76561190000000000" } as LaunchTicketIdentity;
    const prepare = () => gameLauncherInternals.prepareClient(request, f.root, "http://127.0.0.1:45678/createsession", identity, "clean");
    await prepare();
    expect(onInputProfileRecovered).toHaveBeenCalledOnce();
    const [recovery] = onInputProfileRecovered.mock.calls[0];
    expect(recovery).toMatchObject({ restored: false });
    expect(dirname(recovery.damagedCopy)).toBe(f.state);
    expect(await readFile(f.profile, "utf8")).toContain("<Trigger>Shift+M</Trigger>");
    // A refreshed ticket prepares the client again: the profile is usable now.
    await prepare();
    expect(onInputProfileRecovered).toHaveBeenCalledOnce();
  });
});

describe("recovery notice", () => {
  it.each(APP_LOCALES)("tells the player where the damaged file was kept in %s", (locale) => {
    const kept = String.raw`C:\Users\Player\AppData\Roaming\ROTK Launcher\logs\fixture\input-profile\InputProfile_User.damaged.xml`;
    expect(MAIN_COPY[locale].inputProfile.restored(kept)).toContain(kept);
    expect(MAIN_COPY[locale].inputProfile.reset(kept)).toContain(kept);
    expect(MAIN_COPY[locale].inputProfile.reset(kept)).not.toBe(MAIN_COPY[locale].inputProfile.restored(kept));
  });
});
