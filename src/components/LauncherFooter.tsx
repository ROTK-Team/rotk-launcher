import { CircleAlert, Download, KeyRound, Play, RotateCcw, Settings2 } from "lucide-react";
import { launcherUpdateBlocksPlay } from "../../shared/launcher-update";
import type { LauncherSnapshot } from "../../shared/contracts";
import type { PlayerRole, ServerId } from "../../shared/launch-profile";
import { useI18n, type Copy } from "../i18n";
import { ServerSelect } from "./ServerSelect";

interface LauncherFooterProps {
  snapshot: LauncherSnapshot;
  busy: boolean;
  onPrimary(): void;
  onSetup(): void;
  onIdentity(): void;
  onSelectLaunchProfile(serverId: ServerId, role: PlayerRole): void;
}

function statusCopy(snapshot: LauncherSnapshot, copy: Copy): { label: string; detail: string } {
  if (snapshot.phase === "running") {
    return {
      label: copy.footer.inGame,
      detail: snapshot.gamePid ? `${copy.footer.process} ${snapshot.gamePid}` : copy.footer.activeProcess,
    };
  }
  const assetSyncActive = snapshot.assetSync.status === "checking"
    || snapshot.assetSync.status === "downloading"
    || snapshot.assetSync.status === "installing";
  if (snapshot.phase !== "installing" && assetSyncActive) {
    const progress = snapshot.assetSync.progress;
    const bytePercent = progress && progress.totalBytes > 0
      ? (progress.completedBytes / progress.totalBytes) * 100
      : null;
    const packPercent = progress && progress.totalAssets > 0
      ? (progress.assetsCompleted / progress.totalAssets) * 100
      : null;
    const percent = snapshot.assetSync.status === "installing"
      ? packPercent
      : bytePercent ?? packPercent;
    const status = copy.assets.status[snapshot.assetSync.status];
    const detail = percent === null
      ? status
      : `${status} — ${Math.min(100, Math.max(0, Math.round(percent)))}%`;
    return { label: copy.assets.updating, detail };
  }
  if (snapshot.phase === "launching") {
    const assetProgress = snapshot.assetSync.progress;
    if (assetProgress && assetProgress.totalBytes > 0) {
      const percent = Math.min(100, Math.round((assetProgress.completedBytes / assetProgress.totalBytes) * 100));
      return { label: copy.footer.launching, detail: `${copy.assets.updating} — ${percent}%` };
    }
    const integrity = snapshot.integrityCheck;
    if (integrity && integrity.totalFiles > 0) {
      const percent = Math.min(100, Math.round((integrity.hashedFiles / integrity.totalFiles) * 100));
      return { label: copy.footer.launching, detail: `${copy.integrity.verifying} — ${percent}%` };
    }
    return { label: copy.footer.launching, detail: copy.footer.preparingClient };
  }
  if (snapshot.phase === "installing") return { label: copy.footer.installing, detail: copy.footer.secureCopy };
  if (snapshot.error) return { label: copy.footer.attention, detail: snapshot.error };
  if (snapshot.phase === "ready" && !snapshot.playerIdentity.configured) {
    return { label: copy.footer.accountRequired, detail: copy.footer.missingAccountKey };
  }
  if (snapshot.phase === "ready") return { label: copy.footer.ready, detail: snapshot.installationRoot ?? copy.footer.clientConfigured };
  return { label: copy.footer.setupRequired, detail: copy.footer.createIndependentInstall };
}

export function LauncherFooter({
  snapshot,
  busy,
  onPrimary,
  onSetup,
  onIdentity,
  onSelectLaunchProfile,
}: LauncherFooterProps) {
  const { copy } = useI18n();
  const status = statusCopy(snapshot, copy);
  const ready = snapshot.canPlay;
  const running = snapshot.phase === "running" || snapshot.phase === "launching";
  const installing = snapshot.phase === "installing";
  const updatePending = snapshot.updateRequired || launcherUpdateBlocksPlay(snapshot.launcherUpdate);
  const needsAccountKey = snapshot.phase === "ready" && !snapshot.playerIdentity.configured;
  const primaryLabel = updatePending && !running && !installing
    ? copy.update.download
    : ready
    ? copy.footer.play
    : running
      ? copy.footer.inGame
      : installing
        ? copy.footer.installing
        : needsAccountKey
          ? copy.footer.addAccountKey
          : copy.footer.install;

  return (
    <footer className="launcher-footer">
      <div className="launcher-footer__status">
        <span className={`status-pulse ${snapshot.canPlay ? "is-ready" : ""}`} />
        <div>
          <strong>{status.label}</strong>
          <small title={status.detail}>{status.detail}</small>
        </div>
      </div>

      <ServerSelect
        snapshot={snapshot}
        disabled={busy || running || installing}
        onSelect={onSelectLaunchProfile}
      />

      <div className="footer-tools">
        <button type="button" onClick={onIdentity} disabled={installing} aria-label={copy.footer.playerIdentity} title={copy.footer.playerIdentity}>
          <KeyRound size={19} />
        </button>
        <button type="button" onClick={onSetup} disabled={installing} aria-label={copy.footer.settings} title={copy.footer.settings}>
          {snapshot.error ? <CircleAlert size={20} /> : snapshot.installationRoot ? <Settings2 size={20} /> : <RotateCcw size={20} />}
        </button>
      </div>

      <button
        type="button"
        className={`play-button ${ready ? "is-ready" : ""}`}
        disabled={busy || running || installing}
        onClick={onPrimary}
      >
        <span className="play-button__copy"><small>RETURN OF THE KING</small><strong>{primaryLabel}</strong></span>
        {updatePending && !running && !installing ? <Download size={24} /> : <Play size={24} fill="currentColor" />}
      </button>
    </footer>
  );
}
