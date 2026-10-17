import type {
  AssetSyncProgress,
  InstallProgress,
  LauncherSnapshot,
} from "../shared/contracts";

export type GlobalActivityKind =
  | "installation"
  | "asset-sync"
  | "integrity"
  | "launch"
  | "launcher-update";

export interface GlobalActivity {
  id: "primary" | "launcher-update";
  kind: GlobalActivityKind;
  stage: InstallProgress["phase"] | AssetSyncProgress["phase"] | "launching" | "checking" | "downloading" | "background" | null;
  detail: string | null;
  progressPercent: number | null;
  completedBytes: number | null;
  totalBytes: number | null;
  completedItems: number | null;
  totalItems: number | null;
}

function ratioPercent(completed: number, total: number): number | null {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, (completed / total) * 100));
}

function installActivity(snapshot: LauncherSnapshot): GlobalActivity | null {
  if (snapshot.phase !== "installing") return null;
  const progress = snapshot.progress;
  const bytePercent = progress ? ratioPercent(progress.completedBytes, progress.totalBytes) : null;
  const itemPercent = progress ? ratioPercent(progress.filesCompleted, progress.totalFiles) : null;
  return {
    id: "primary",
    kind: "installation",
    stage: progress?.phase ?? null,
    detail: progress?.currentFile || null,
    progressPercent: bytePercent ?? itemPercent,
    completedBytes: progress?.totalBytes ? progress.completedBytes : null,
    totalBytes: progress?.totalBytes || null,
    completedItems: progress?.totalFiles ? progress.filesCompleted : null,
    totalItems: progress?.totalFiles || null,
  };
}

function assetActivity(snapshot: LauncherSnapshot): GlobalActivity | null {
  const { status, progress } = snapshot.assetSync;
  if (status !== "checking" && status !== "downloading" && status !== "installing") return null;

  const bytePercent = progress ? ratioPercent(progress.completedBytes, progress.totalBytes) : null;
  const itemPercent = progress ? ratioPercent(progress.assetsCompleted, progress.totalAssets) : null;
  // While an archive is being installed, the already-downloaded byte count can
  // be 100% even though extraction is still in progress. Pack count is the
  // honest meter for that phase; downloads remain byte-based.
  const progressPercent = status === "installing"
    ? itemPercent
    : bytePercent ?? itemPercent;

  return {
    id: "primary",
    kind: "asset-sync",
    stage: progress?.phase ?? status,
    detail: progress?.assetName || null,
    progressPercent,
    completedBytes: progress?.totalBytes ? progress.completedBytes : null,
    totalBytes: progress?.totalBytes || null,
    completedItems: progress?.totalAssets ? progress.assetsCompleted : null,
    totalItems: progress?.totalAssets || null,
  };
}

/** An asset update downloading while the launcher waits; Play stays available. */
function prefetchActivity(snapshot: LauncherSnapshot): GlobalActivity | null {
  const prefetch = snapshot.assetSync.prefetch;
  if (prefetch?.status !== "downloading") return null;
  const progress = prefetch.progress;
  return {
    id: "primary",
    kind: "asset-sync",
    stage: "background",
    detail: progress?.assetName || null,
    progressPercent: progress ? ratioPercent(progress.completedBytes, progress.totalBytes) : null,
    completedBytes: progress?.totalBytes ? progress.completedBytes : null,
    totalBytes: progress?.totalBytes || null,
    completedItems: progress?.totalAssets ? progress.assetsCompleted : null,
    totalItems: progress?.totalAssets || null,
  };
}

function integrityActivity(snapshot: LauncherSnapshot): GlobalActivity | null {
  const progress = snapshot.integrityCheck;
  if (!progress) return null;
  const filePercent = ratioPercent(progress.hashedFiles, progress.totalFiles);
  const bytePercent = ratioPercent(progress.hashedBytes, progress.totalBytes);
  return {
    id: "primary",
    kind: "integrity",
    stage: null,
    detail: null,
    progressPercent: filePercent ?? bytePercent,
    completedBytes: progress.totalBytes ? progress.hashedBytes : null,
    totalBytes: progress.totalBytes || null,
    completedItems: progress.totalFiles ? progress.hashedFiles : null,
    totalItems: progress.totalFiles || null,
  };
}

function launchActivity(snapshot: LauncherSnapshot): GlobalActivity | null {
  if (snapshot.phase !== "launching") return null;
  return {
    id: "primary",
    kind: "launch",
    stage: "launching",
    detail: null,
    progressPercent: null,
    completedBytes: null,
    totalBytes: null,
    completedItems: null,
    totalItems: null,
  };
}

function updateActivity(snapshot: LauncherSnapshot): GlobalActivity | null {
  const update = snapshot.launcherUpdate;
  if (update.status !== "checking" && update.status !== "downloading") return null;
  return {
    id: "launcher-update",
    kind: "launcher-update",
    stage: update.status,
    detail: update.availableVersion ? `v${update.availableVersion}` : null,
    progressPercent: update.status === "downloading"
      ? ratioPercent(update.progressPercent ?? 0, 100)
      : null,
    completedBytes: null,
    totalBytes: null,
    completedItems: null,
    totalItems: null,
  };
}

/**
 * Derives homepage activity without introducing a second IPC state machine.
 * The updater is independent from the main operation, so both can be visible.
 */
export function selectGlobalActivities(snapshot: LauncherSnapshot): GlobalActivity[] {
  const primary = installActivity(snapshot)
    ?? assetActivity(snapshot)
    ?? integrityActivity(snapshot)
    ?? launchActivity(snapshot)
    ?? prefetchActivity(snapshot);
  const update = updateActivity(snapshot);
  return [primary, update].filter((activity): activity is GlobalActivity => activity !== null);
}

