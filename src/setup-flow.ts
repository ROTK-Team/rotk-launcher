import { useRef } from "react";
import type { InstallProgress, LauncherSnapshot } from "../shared/contracts";
import type { AppLocale } from "../shared/locale";

/** Where the player stands between a fresh launcher and Play. */
export type SetupStep = "h1z1" | "location" | "patch" | "copy" | "key" | "done";

/**
 * The game is installed and can be used. A damaged installation keeps its
 * folder on record (`error`, then the phases of the picks that replace it):
 * that is not a game to play, the assistant starts over from H1Z1.
 */
export function gameInstalled(snapshot: LauncherSnapshot): boolean {
  return snapshot.installationRoot !== null
    && !["error", "unconfigured", "source-selected", "destination-selected"].includes(snapshot.phase);
}

/**
 * `relocating`: an installed player prepares another installation from the
 * settings. The installed client stays in use, so only the choices are shown.
 */
export function setupStep(snapshot: LauncherSnapshot, relocating: boolean): SetupStep {
  if (snapshot.phase === "installing") return "copy";
  if (relocating || !gameInstalled(snapshot)) return snapshot.selection.sourceRoot ? "location" : "h1z1";
  return snapshot.playerIdentity.configured ? "done" : "key";
}

/**
 * The steps the assistant lists. A client that is already outside Steam is
 * used where it is (no location step); another installation for a player who
 * already has a key ends without the account step.
 */
export function setupStepList(snapshot: LauncherSnapshot, relocating: boolean): Exclude<SetupStep, "done">[] {
  // Steam's H1Z1.exe is not the supported build: the patch step fetches the right one first.
  const patch: Exclude<SetupStep, "done">[] = snapshot.steamExecutable ? ["patch"] : [];
  const steps: Exclude<SetupStep, "done">[] = snapshot.selection.sourceKind === "direct"
    ? ["h1z1", ...patch, "copy", "key"]
    : ["h1z1", "location", ...patch, "copy", "key"];
  return relocating && snapshot.playerIdentity.configured ? steps.filter((step) => step !== "key") : steps;
}

// One bar for the whole install: the copy is nearly all of it.
const PHASE_SPAN: Record<InstallProgress["phase"], [from: number, to: number]> = {
  scanning: [0, 3], copying: [3, 85], verifying: [85, 96], configuring: [96, 99], finalizing: [99, 100],
};

export function installPercent(progress: InstallProgress | null): number {
  if (!progress) return 0;
  const [from, to] = PHASE_SPAN[progress.phase];
  const within = progress.phase === "copying" || progress.phase === "verifying"
    ? (progress.totalBytes > 0 ? progress.completedBytes / progress.totalBytes : 0)
    : 0.5;
  return from + (to - from) * Math.min(1, Math.max(0, within));
}

export function gigabytes(bytes: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale === "fr" ? "fr-FR" : locale === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 1 })
    .format(bytes / 1024 ** 3);
}

/** Minutes left for the copy, from the speed seen in this window; null until a few seconds of it were seen. */
export function useMinutesLeft(progress: InstallProgress | null): number | null {
  const start = useRef<{ at: number; bytes: number } | null>(null);
  if (progress?.phase !== "copying") {
    start.current = null;
    return null;
  }
  start.current ??= { at: Date.now(), bytes: progress.completedBytes };
  const elapsed = (Date.now() - start.current.at) / 1000;
  const copied = progress.completedBytes - start.current.bytes;
  if (elapsed < 3 || copied <= 0) return null;
  return Math.ceil((progress.totalBytes - progress.completedBytes) / (copied / elapsed) / 60);
}
