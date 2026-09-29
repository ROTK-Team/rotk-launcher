import { useEffect, useRef } from "react";
import { ArrowRight, Download, X } from "lucide-react";
import type { LauncherSnapshot } from "../../shared/contracts";
import { hasLauncherUpdate } from "../../shared/launcher-update";
import { useI18n } from "../i18n";

interface LauncherUpdatePromptProps {
  snapshot: LauncherSnapshot;
  open: boolean;
  busy: boolean;
  onClose(): void;
  onDownload(): void;
  onInstall(): void;
  onCheck(): void;
}

export function LauncherUpdatePrompt({
  snapshot, open, busy, onClose, onDownload, onInstall, onCheck,
}: LauncherUpdatePromptProps) {
  const { copy } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const update = snapshot.launcherUpdate;
  const knownUpdate = hasLauncherUpdate(update);
  const visible = open && (knownUpdate || snapshot.updateRequired);
  const downloading = update.status === "downloading";
  const downloaded = update.status === "downloaded";
  const running = snapshot.gamePid !== null || snapshot.phase === "running" || snapshot.phase === "launching";

  useEffect(() => {
    if (visible) dialog.current?.showModal();
    else dialog.current?.close();
  }, [visible]);

  return (
    <dialog ref={dialog} className="launcher-update-prompt" aria-labelledby="launcher-update-title"
      aria-describedby="launcher-update-detail" onCancel={onClose} onClose={onClose}>
      <button type="button" className="launcher-update-prompt__close" aria-label={copy.update.close} onClick={onClose}>
        <X size={22} />
      </button>
      <div className="launcher-update-prompt__icon"><Download size={30} /></div>
      <span className="launcher-update-prompt__eyebrow">ROTK LAUNCHER</span>
      <h1 id="launcher-update-title">{downloaded ? copy.update.readyTitle : copy.update.promptTitle}</h1>
      <p id="launcher-update-detail">{downloaded ? copy.update.restartDetail : copy.update.promptDetail}</p>
      <div className="launcher-update-prompt__versions">
        <div><small>{copy.update.currentVersion}</small><strong>v{snapshot.appVersion}</strong></div>
        <ArrowRight size={22} aria-hidden="true" />
        <div><small>{copy.update.newVersion}</small><strong>{update.availableVersion ? `v${update.availableVersion}` : copy.update.check}</strong></div>
      </div>
      {downloading && (
        <div className="launcher-update-prompt__progress" role="status">
          <span>{copy.update.downloading} · {update.progressPercent ?? 0}%</span>
          <progress max={100} value={update.progressPercent ?? 0} aria-label={copy.update.downloading} />
        </div>
      )}
      {update.status === "error" && <p className="launcher-update-prompt__error" role="alert">{copy.update.failed}: {update.error}</p>}
      {!knownUpdate && <p role="status">{copy.update.requiredDetail}</p>}
      {downloaded && running && <p role="status">{copy.update.closeGame}</p>}
      <div className="launcher-update-prompt__actions">
        <button type="button" className="launcher-update-prompt__primary" autoFocus
          disabled={busy || downloading || update.status === "checking" || (downloaded && running)} onClick={downloaded ? onInstall : knownUpdate ? onDownload : onCheck}>
          <Download size={18} />
          {!knownUpdate ? copy.update.check : downloaded ? copy.update.restart : downloading ? copy.update.downloading : update.status === "error" ? copy.update.retry : copy.update.download}
        </button>
        <button type="button" className="launcher-update-prompt__secondary" onClick={onClose}>
          {copy.update.later}
        </button>
      </div>
    </dialog>
  );
}
