import { describe, expect, it } from "vitest";
import type { LauncherSnapshot } from "../shared/contracts";
import { launcherUpdateBlocksPlay } from "../shared/launcher-update";
import { assetSyncActive, gameSessionActive, primaryAction } from "../shared/primary-action";

/** An installed launcher with a key, ready to play. */
function snapshot(overrides: Partial<LauncherSnapshot> = {}): LauncherSnapshot {
  return {
    appVersion: "2.0.50",
    phase: "ready",
    selection: { sourceRoot: null, destinationRoot: null, sourceKind: null, sourceDetected: false, destinationRecommended: false },
    installationRoot: "D:\\Games\\ROTK",
    updates: [],
    runtime: { serverId: "game2", environment: "production", label: "LIVE", websiteOrigin: "https://rotk.app", players: null, capacity: null, servers: [] },
    playerIdentity: { serverId: "game2", role: "player", configured: true, keys: {} },
    launcherUpdate: { status: "idle", availableVersion: null, progressPercent: null, error: null },
    assetSync: { enabled: true, status: "up-to-date", packVersion: "1", lastSyncAt: null, progress: null, warning: null },
    playerFont: { selected: "default", launcherSelected: "default", options: [] },
    integrityCheck: null,
    progress: null,
    error: null,
    notice: null,
    gamePid: null,
    updateRequired: false,
    canPlay: true,
    ...overrides,
  } as LauncherSnapshot;
}

describe("the main button", () => {
  it("plays when the main process allows it, and waits for the renderer's own request", () => {
    expect(primaryAction(snapshot(), false)).toEqual({ kind: "play", enabled: true });
    expect(primaryAction(snapshot(), true)).toEqual({ kind: "play", enabled: false });
  });

  it("says LAUNCHING, not IN GAME, until the game is started", () => {
    expect(primaryAction(snapshot({ phase: "launching", canPlay: false }), false)).toEqual({ kind: "launching", enabled: false });
    expect(primaryAction(snapshot({ phase: "running", gamePid: 4242, canPlay: false }), false)).toEqual({ kind: "stop-game", enabled: true });
  });

  it("puts a blocking launcher update before Play, but never over a game or an install", () => {
    const available = { status: "update-available", availableVersion: "2.0.51", progressPercent: null, error: null } as LauncherSnapshot["launcherUpdate"];
    // Whether a known update blocks Play is decided in shared/launcher-update;
    // the button follows that rule, whatever it says.
    const blocks = launcherUpdateBlocksPlay(available);
    expect(primaryAction(snapshot({ launcherUpdate: available, canPlay: !blocks }), false))
      .toEqual({ kind: blocks ? "update" : "play", enabled: true });
    expect(primaryAction(snapshot({ updateRequired: true, canPlay: false }), false)).toEqual({ kind: "update", enabled: true });
    expect(primaryAction(snapshot({ updateRequired: true, phase: "running", gamePid: 1, canPlay: false }), false).kind).toBe("stop-game");
    expect(primaryAction(snapshot({ updateRequired: true, phase: "installing", canPlay: false }), false).kind).toBe("installing");
    // A failed download does not lock Play.
    const failed = { ...available, status: "error", error: "net" } as LauncherSnapshot["launcherUpdate"];
    expect(primaryAction(snapshot({ launcherUpdate: failed }), false).kind).toBe("play");
  });

  it("asks for the key of the selected profile on an installed launcher", () => {
    const identity = { serverId: "game2", role: "admin", configured: false, keys: {} } as LauncherSnapshot["playerIdentity"];
    expect(primaryAction(snapshot({ playerIdentity: identity, canPlay: false }), false)).toEqual({ kind: "add-key", enabled: true });
  });

  it("waits, instead of offering INSTALL, while the last game's report is being finished", () => {
    expect(primaryAction(snapshot({ canPlay: false }), false)).toEqual({ kind: "wait", enabled: false });
  });

  it("opens the setup for every state without a usable installation", () => {
    for (const phase of ["unconfigured", "source-selected", "destination-selected", "error"] as const) {
      expect(primaryAction(snapshot({ phase, installationRoot: null, canPlay: false }), false)).toEqual({ kind: "setup", enabled: true });
    }
    // A damaged installation found at startup keeps its root but is not ready.
    expect(primaryAction(snapshot({ phase: "error", canPlay: false }), false).kind).toBe("setup");
    expect(primaryAction(snapshot({ phase: "installing", canPlay: false }), false)).toEqual({ kind: "installing", enabled: false });
  });
});

describe("what locks the controls", () => {
  it("counts a game from the launch to its exit", () => {
    expect(gameSessionActive(snapshot())).toBe(false);
    expect(gameSessionActive(snapshot({ phase: "launching" }))).toBe(true);
    expect(gameSessionActive(snapshot({ phase: "running" }))).toBe(true);
    expect(gameSessionActive(snapshot({ gamePid: 7 }))).toBe(true);
  });

  it("counts an asset pass while it checks, downloads or installs", () => {
    const withStatus = (status: LauncherSnapshot["assetSync"]["status"]) =>
      snapshot({ assetSync: { ...snapshot().assetSync, status } });
    for (const status of ["checking", "downloading", "installing"] as const) expect(assetSyncActive(withStatus(status))).toBe(true);
    for (const status of ["idle", "disabled", "up-to-date", "warning", "error"] as const) expect(assetSyncActive(withStatus(status))).toBe(false);
  });
});
