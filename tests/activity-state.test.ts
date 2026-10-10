import { describe, expect, it } from "vitest";
import type { LauncherSnapshot } from "../shared/contracts.js";
import { selectGlobalActivities } from "../src/activity-state.js";

function snapshot(overrides: Partial<LauncherSnapshot> = {}): LauncherSnapshot {
  return {
    appVersion: "0.8.0",
    phase: "ready",
    selection: {
      sourceRoot: "C:\\H1Z1",
      destinationRoot: null,
      sourceKind: "direct",
      sourceDetected: false,
      destinationRecommended: false,
    },
    installationRoot: "C:\\H1Z1",
    updates: [],
    runtime: {
      serverId: "game2",
      environment: "development",
      label: "ROTK LIVE",
      websiteOrigin: "https://rotk.app",
      players: 12,
      capacity: 150,
      servers: [
        {
          id: "game2",
          label: "ROTK LIVE",
          environment: "production",
          websiteOrigin: "https://rotk.app",
          players: 12,
          capacity: 150,
        },
      ],
    },
    playerIdentity: {
      serverId: "game2",
      role: "player",
      configured: true,
      keys: {
        "game2:player": "0".repeat(32),
        "game2:admin": null,
        "test:player": null,
        "test:admin": null,
      },
    },
    launcherUpdate: {
      status: "idle",
      availableVersion: null,
      progressPercent: null,
      error: null,
    },
    assetSync: {
      enabled: true,
      status: "up-to-date",
      packVersion: "1.1.0",
      lastSyncAt: null,
      progress: null,
      warning: null,
    },
    integrityCheck: null,
    progress: null,
    error: null,
    notice: null,
    gamePid: null,
    updateRequired: false,
    canPlay: true,
    ...overrides,
  };
}

describe("homepage activity selector", () => {
  it.each(["unconfigured", "source-selected", "destination-selected", "ready", "running"] as const)(
    "stays hidden while %s is idle",
    (phase) => expect(selectGlobalActivities(snapshot({ phase }))).toEqual([]),
  );

  it("shows installation immediately, before the first progress event", () => {
    expect(selectGlobalActivities(snapshot({ phase: "installing" }))).toMatchObject([
      { kind: "installation", stage: null, progressPercent: null },
    ]);
  });

  it("uses bytes for client copy progress and clamps overrun", () => {
    const [activity] = selectGlobalActivities(snapshot({
      phase: "installing",
      progress: {
        phase: "copying",
        completedBytes: 125,
        totalBytes: 100,
        filesCompleted: 2,
        totalFiles: 10,
        currentFile: "H1Z1.exe",
      },
    }));
    expect(activity).toMatchObject({
      kind: "installation",
      stage: "copying",
      detail: "H1Z1.exe",
      progressPercent: 100,
    });
  });

  it("shows manual or post-install asset downloads while the launcher is ready", () => {
    const [activity] = selectGlobalActivities(snapshot({
      assetSync: {
        enabled: true,
        status: "downloading",
        packVersion: null,
        lastSyncAt: null,
        warning: null,
        progress: {
          phase: "downloading",
          assetName: "assets_x64_1.zip",
          assetsCompleted: 2,
          totalAssets: 7,
          completedBytes: 25,
          totalBytes: 100,
        },
      },
    }));
    expect(activity).toMatchObject({
      kind: "asset-sync",
      detail: "assets_x64_1.zip",
      progressPercent: 25,
      completedItems: 2,
      totalItems: 7,
    });
  });

  it("uses completed packs rather than downloaded bytes during extraction", () => {
    const [activity] = selectGlobalActivities(snapshot({
      assetSync: {
        enabled: true,
        status: "installing",
        packVersion: null,
        lastSyncAt: null,
        warning: null,
        progress: {
          phase: "installing",
          assetName: "assets_x64_1.zip",
          assetsCompleted: 3,
          totalAssets: 6,
          completedBytes: 100,
          totalBytes: 100,
        },
      },
    }));
    expect(activity.progressPercent).toBe(50);
  });

  it("keeps checking states visible without inventing a percentage", () => {
    const [activity] = selectGlobalActivities(snapshot({
      assetSync: {
        enabled: true,
        status: "checking",
        packVersion: null,
        lastSyncAt: null,
        warning: null,
        progress: null,
      },
    }));
    expect(activity).toMatchObject({ kind: "asset-sync", progressPercent: null });
  });

  it("prioritizes asset work over integrity and generic launch", () => {
    const [activity] = selectGlobalActivities(snapshot({
      phase: "launching",
      assetSync: {
        enabled: true,
        status: "checking",
        packVersion: "1.1.0",
        lastSyncAt: null,
        warning: null,
        progress: null,
      },
      integrityCheck: { hashedFiles: 5, totalFiles: 10, hashedBytes: 50, totalBytes: 100 },
    }));
    expect(activity.kind).toBe("asset-sync");
  });

  it("shows integrity progress before falling back to generic launch", () => {
    const [integrity] = selectGlobalActivities(snapshot({
      phase: "launching",
      integrityCheck: { hashedFiles: 3, totalFiles: 4, hashedBytes: 20, totalBytes: 100 },
    }));
    expect(integrity).toMatchObject({ kind: "integrity", progressPercent: 75 });

    const [launch] = selectGlobalActivities(snapshot({ phase: "launching" }));
    expect(launch).toMatchObject({ kind: "launch", progressPercent: null });
  });

  it("keeps the independent launcher update visible beside core work", () => {
    const activities = selectGlobalActivities(snapshot({
      phase: "launching",
      launcherUpdate: {
        status: "downloading",
        availableVersion: "0.9.0",
        progressPercent: 42.4,
        error: null,
      },
    }));
    expect(activities).toHaveLength(2);
    expect(activities[0].kind).toBe("launch");
    expect(activities[1]).toMatchObject({
      kind: "launcher-update",
      detail: "v0.9.0",
      progressPercent: 42.4,
    });
  });
});
