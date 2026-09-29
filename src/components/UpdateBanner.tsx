import { useState } from "react";
import { Download } from "lucide-react";
import type { LauncherSnapshot } from "../../shared/contracts";
import { useI18n } from "../i18n";
import { hasLauncherUpdate } from "../../shared/launcher-update";

interface UpdateBannerProps {
  snapshot: LauncherSnapshot;
  busy: boolean;
  onDownload(): void;
  onInstall(): void;
}

export function UpdateBanner({ snapshot, busy, onDownload, onInstall }: UpdateBannerProps) {
  const { copy } = useI18n();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const update = snapshot.launcherUpdate;
  const notification = `${update.availableVersion}:${update.status}`;
  const running = snapshot.gamePid !== null || snapshot.phase === "running" || snapshot.phase === "launching";

  if (!hasLauncherUpdate(update) || dismissed === notification) return null;

  const version = `v${update.availableVersion}`;
  const label =
    update.status === "downloaded"
        ? copy.update.restart
        : update.status === "downloading"
          ? `${copy.update.downloading} · ${update.progressPercent ?? 0}%`
        : update.status === "error"
          ? copy.update.failed
          : copy.update.available(version);
  const detail =
    update.status === "error"
      ? update.error ?? ""
      : update.status === "downloaded"
        ? running ? copy.update.closeGame : copy.update.restartDetail
        : copy.update.availableDetail;

  return (
    <aside className="update-banner" role="status">
      <Download size={28} aria-hidden="true" />
      <div className="update-banner__text">
        <strong>{label}</strong>
        <small title={detail}>{detail}</small>
        {update.status === "downloading" && (
          <progress max={100} value={update.progressPercent ?? 0} aria-label={copy.update.downloading} />
        )}
      </div>
      {update.status === "update-available" && (
        <button type="button" disabled={busy} onClick={onDownload}>
          {copy.update.download}
        </button>
      )}
      {update.status === "error" && (
        <button type="button" disabled={busy} onClick={onDownload}>
          {copy.update.retry}
        </button>
      )}
      {update.status === "downloaded" && (
        <button type="button" disabled={busy || running} onClick={onInstall}>
          {copy.update.restart}
        </button>
      )}
      <button
        type="button"
        className="update-banner__dismiss"
        aria-label={copy.update.dismiss}
        onClick={() => setDismissed(notification)}
      >
        ×
      </button>
    </aside>
  );
}
