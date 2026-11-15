import { describe, expect, it } from "vitest";
import type { LauncherPhase, LauncherSnapshot } from "../shared/contracts";
import { gameInstalled, setupStep, setupStepList } from "../src/setup-flow";

const NO_SELECTION = { sourceRoot: null, destinationRoot: null, sourceKind: null, sourceDetected: false, destinationRecommended: false };
const STEAM = { ...NO_SELECTION, sourceRoot: "C:\\Steam\\steamapps\\common\\H1Z1 King of the Kill", sourceKind: "copy-required" as const };

/** Only what the assistant reads. */
function snapshot(phase: LauncherPhase, installationRoot: string | null, overrides: { configured?: boolean; selection?: object } = {}): LauncherSnapshot {
  return {
    phase,
    installationRoot,
    selection: overrides.selection ?? NO_SELECTION,
    playerIdentity: { configured: overrides.configured ?? true },
  } as LauncherSnapshot;
}

describe("the screen the assistant shows", () => {
  it("ends on the key or the end when the game is installed, in every phase that has a game", () => {
    for (const phase of ["ready", "launching", "running"] as const) {
      expect(setupStep(snapshot(phase, "D:\\Games\\ROTK"), false)).toBe("done");
      expect(setupStep(snapshot(phase, "D:\\Games\\ROTK", { configured: false }), false)).toBe("key");
    }
  });

  it("starts over from H1Z1 when the installation on record is damaged, then follows the picks", () => {
    // The folder stays on record while the phase says the game is not usable.
    expect(setupStep(snapshot("error", "D:\\Games\\ROTK"), false)).toBe("h1z1");
    expect(setupStep(snapshot("unconfigured", "D:\\Games\\ROTK"), false)).toBe("h1z1");
    expect(setupStep(snapshot("source-selected", "D:\\Games\\ROTK", { selection: STEAM }), false)).toBe("location");
    expect(setupStep(snapshot("destination-selected", "D:\\Games\\ROTK", { selection: STEAM }), false)).toBe("location");
    for (const phase of ["error", "unconfigured", "source-selected", "destination-selected"] as const) {
      expect(gameInstalled(snapshot(phase, "D:\\Games\\ROTK"))).toBe(false);
    }
  });

  it("asks for H1Z1 then the location on a launcher with no game", () => {
    expect(setupStep(snapshot("unconfigured", null), false)).toBe("h1z1");
    expect(setupStep(snapshot("source-selected", null, { selection: STEAM }), false)).toBe("location");
    expect(setupStep(snapshot("destination-selected", null, { selection: STEAM }), false)).toBe("location");
    expect(setupStep(snapshot("error", null), false)).toBe("h1z1");
    expect(gameInstalled(snapshot("ready", null))).toBe(false);
  });

  it("shows the copy while it runs, whatever was there before", () => {
    expect(setupStep(snapshot("installing", null, { selection: STEAM }), false)).toBe("copy");
    expect(setupStep(snapshot("installing", "D:\\Games\\ROTK", { selection: STEAM }), true)).toBe("copy");
  });

  it("shows only the choices to a player who prepares another installation", () => {
    expect(setupStep(snapshot("ready", "D:\\Games\\ROTK"), true)).toBe("h1z1");
    expect(setupStep(snapshot("ready", "D:\\Games\\ROTK", { selection: STEAM }), true)).toBe("location");
    expect(setupStepList(snapshot("ready", "D:\\Games\\ROTK", { selection: STEAM }), true)).toEqual(["h1z1", "location", "copy"]);
    expect(setupStepList(snapshot("ready", "D:\\Games\\ROTK", { selection: STEAM, configured: false }), true)).toEqual(["h1z1", "location", "copy", "key"]);
  });

  it("lists no location step for a client used where it is", () => {
    expect(setupStepList(snapshot("source-selected", null, { selection: { ...STEAM, sourceKind: "direct" } }), false)).toEqual(["h1z1", "copy", "key"]);
  });
});
