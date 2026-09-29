import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, FolderOpen, HardDrive, PackageCheck, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { InstallDrive, LauncherSnapshot } from "../../shared/contracts";
import { useI18n } from "../i18n";
import { LanguagePicker } from "./WindowChrome";

interface InstallPanelProps {
  snapshot: LauncherSnapshot;
  open: boolean;
  busy: boolean;
  onClose(): void;
  onSelectSource(): void;
  onSelectDestination(): void;
  onChooseDrive(root: string): void;
  onInstall(): void;
  onCancel(): void;
  onVerifyAssets(): void;
  onRestoreAssets(): void;
  onToggleAssetSync(enabled: boolean): void;
  debugSessionBusy: boolean;
  debugSessionFailed: boolean;
  debugSessionLocked: boolean;
  onToggleDebugSession(enabled: boolean): void;
}

function shortPath(value: string | null, emptyLabel: string): string {
  if (!value) return emptyLabel;
  return value.length > 52 ? `…${value.slice(-51)}` : value;
}

function progressPercent(snapshot: LauncherSnapshot): number {
  const progress = snapshot.progress;
  if (!progress || progress.totalBytes <= 0) return progress?.phase === "scanning" ? 4 : 0;
  return Math.min(100, Math.max(0, (progress.completedBytes / progress.totalBytes) * 100));
}

export function InstallPanel({
  snapshot,
  open,
  busy,
  onClose,
  onSelectSource,
  onSelectDestination,
  onChooseDrive,
  onInstall,
  onCancel,
  onVerifyAssets,
  onRestoreAssets,
  onToggleAssetSync,
  debugSessionBusy,
  debugSessionFailed,
  debugSessionLocked,
  onToggleDebugSession,
}: InstallPanelProps) {
  const { copy } = useI18n();
  const hasSource = Boolean(snapshot.selection.sourceRoot);
  const hasDestination = Boolean(snapshot.selection.destinationRoot);
  const sourceKind = snapshot.selection.sourceKind;
  const usesExistingClient = sourceKind === "direct";
  const requiresCopy = sourceKind === "copy-required";
  const installing = snapshot.phase === "installing";
  const percentage = progressPercent(snapshot);
  const progressFile = snapshot.progress && snapshot.progress.phase !== "copying"
    ? copy.install.progressFiles[snapshot.progress.phase]
    : snapshot.progress?.currentFile;
  const assetSync = snapshot.assetSync;
  const assetSyncActive = assetSync.status === "checking"
    || assetSync.status === "downloading"
    || assetSync.status === "installing";
  const assetPercentage = assetSync.progress && assetSync.progress.totalBytes > 0
    ? Math.min(100, Math.max(0, (assetSync.progress.completedBytes / assetSync.progress.totalBytes) * 100))
    : 0;
  const debugSession = snapshot.debugSession;
  const debugCopy = copy.diagnostics.debug;
  const debugStatus = debugSessionBusy ? debugCopy.saving
    : debugSessionFailed ? debugCopy.settingFailed
      : debugSession?.status && debugSession.status !== "idle" ? debugCopy[debugSession.status]
        : debugSession?.enabled ? debugCopy.enabled : null;
  const debugError = !debugSessionBusy && (debugSessionFailed || debugSession?.status === "error");
  const [drives, setDrives] = useState<InstallDrive[]>([]);
  const destinationDrive = snapshot.selection.destinationRoot?.slice(0, 3).toUpperCase() ?? null;

  useEffect(() => {
    if (!open || !requiresCopy) return;
    let current = true;
    void window.rotk.listInstallDrives().then((value) => { if (current) setDrives(value); });
    return () => { current = false; };
  }, [open, requiresCopy, snapshot.selection.destinationRoot]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            className="install-panel__backdrop"
            aria-label={copy.install.closeSetup}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={installing ? undefined : onClose}
          />
          <motion.aside
            className="install-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            aria-label={copy.install.panelLabel}
          >
            <div className="install-panel__topline" />
            <div className="install-panel__header">
              <div>
                <span className="eyebrow">{copy.install.firstInstall}</span>
                <h2>{copy.install.title}</h2>
              </div>
              <div className="install-panel__header-actions">
                <LanguagePicker placement="panel" />
                {!installing && (
                  <button type="button" className="panel-close" aria-label={copy.install.close} onClick={onClose}>
                    <X size={19} />
                  </button>
                )}
              </div>
            </div>

            <p className="install-panel__intro">
              {copy.install.intro}
            </p>

            <div className="safety-note">
              <ShieldCheck size={22} />
              <div>
                <strong>{usesExistingClient
                  ? copy.install.isolatedDetected
                  : requiresCopy
                    ? copy.install.steamDetected
                    : copy.install.protectionActive}</strong>
                <span>{usesExistingClient
                  ? copy.install.isolatedDetail
                  : requiresCopy
                    ? copy.install.steamDetail
                    : copy.install.protectionDetail}</span>
              </div>
            </div>

            <div className="install-steps">
              <button type="button" className={hasSource ? "install-step is-complete" : "install-step"} onClick={onSelectSource} disabled={installing || busy}>
                <span className="install-step__index">{hasSource ? <Check size={16} /> : "01"}</span>
                <FolderOpen size={19} />
                <span className="install-step__copy">
                  <strong>
                    {copy.install.sourceClient}
                    {snapshot.selection.sourceDetected && (
                      <span className="install-step__badge">{copy.install.detectedBadge}</span>
                    )}
                  </strong>
                  <small title={snapshot.selection.sourceRoot ?? undefined}>{shortPath(snapshot.selection.sourceRoot, copy.install.notSelected)}</small>
                </span>
                <span className="install-step__action">{copy.install.choose}</span>
              </button>

              <AnimatePresence initial={false}>
                {requiresCopy && (
                  <motion.button
                    type="button"
                    className={hasDestination ? "install-step is-complete" : "install-step"}
                    onClick={onSelectDestination}
                    disabled={!hasSource || installing || busy}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                  >
                    <span className="install-step__index">{hasDestination ? <Check size={16} /> : "02"}</span>
                    <HardDrive size={19} />
                    <span className="install-step__copy">
                      <strong>
                        {copy.install.rotkInstall}
                        {snapshot.selection.destinationRecommended && hasDestination && (
                          <span className="install-step__badge">{copy.install.recommendedBadge}</span>
                        )}
                      </strong>
                      <small title={snapshot.selection.destinationRoot ?? undefined}>{shortPath(snapshot.selection.destinationRoot, copy.install.notSelected)}</small>
                    </span>
                    <span className="install-step__action">{copy.install.choose}</span>
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            {requiresCopy && drives.length > 0 && (
              <div className="install-drives" role="radiogroup" aria-label={copy.install.driveLabel}>
                <span className="install-drives__label">{copy.install.driveLabel}</span>
                {drives.map((drive) => (
                  <button
                    key={drive.root}
                    type="button"
                    role="radio"
                    aria-checked={destinationDrive === drive.root}
                    className={destinationDrive === drive.root ? "install-drive is-selected" : "install-drive"}
                    disabled={installing || busy}
                    onClick={() => onChooseDrive(drive.root)}
                  >
                    <HardDrive size={15} />
                    <strong>{drive.root.slice(0, 2)}</strong>
                    <small>{copy.install.driveFree(Math.floor(drive.freeBytes / 1024 ** 3))}</small>
                  </button>
                ))}
              </div>
            )}

            {requiresCopy && (
              <p className="install-panel__hint">{installing ? copy.install.resumeHint : copy.install.subfolderHint}</p>
            )}

            {snapshot.error && !installing && (
              <p className="install-panel__error" role="alert">{snapshot.error}</p>
            )}

            {installing && snapshot.progress ? (
              <div className="copy-progress">
                <div className="copy-progress__heading">
                  <span><Copy size={15} /> {copy.install.progressPhases[snapshot.progress.phase]}</span>
                  <strong>{Math.round(percentage)}%</strong>
                </div>
                <div className="copy-progress__track"><i style={{ width: `${percentage}%` }} /></div>
                <div className="copy-progress__file" title={progressFile}>
                  {progressFile}
                </div>
                <button type="button" className="text-button" onClick={onCancel}>{copy.install.cancelCopy}</button>
              </div>
            ) : (
              <button
                type="button"
                className="install-panel__primary"
                disabled={!hasSource || !sourceKind || (requiresCopy && !hasDestination) || busy}
                onClick={onInstall}
              >
                {usesExistingClient ? copy.install.useExisting : copy.install.createInstall}
                <span>{usesExistingClient ? "02" : "03"}</span>
              </button>
            )}

            <section className="debug-session-settings" aria-labelledby="debug-session-title" aria-busy={debugSessionBusy || debugSession?.status === "preparing"}>
              <h3 id="debug-session-title">{debugCopy.title}</h3>
              <label className="debug-session-settings__toggle">
                <input
                  type="checkbox"
                  checked={debugSession?.enabled ?? false}
                  disabled={debugSessionLocked}
                  aria-describedby="debug-session-description"
                  onChange={(event) => onToggleDebugSession(event.target.checked)}
                />
                <span>{debugCopy.enable}</span>
              </label>
              <p id="debug-session-description">{debugCopy.description}</p>
              {debugStatus && (
                <p className={`debug-session-settings__status${debugError ? " is-error" : ""}`} role={debugError ? "alert" : "status"}>
                  {debugStatus}
                  {debugSession?.status === 'ready' && debugSession.fileName && <><br /><code>{debugSession.fileName}</code></>}
                </p>
              )}
            </section>

            {snapshot.installationRoot && !installing && (
              <section className="asset-section" aria-label={copy.assets.title}>
                <div className="asset-section__heading">
                  <span><PackageCheck size={16} /> {copy.assets.title}</span>
                  <strong data-status={assetSync.status}>{copy.assets.status[assetSync.status]}</strong>
                </div>
                <p className="asset-section__description">{copy.assets.description}</p>
                <small className="asset-section__version">
                  {assetSync.packVersion
                    ? copy.assets.packVersion(assetSync.packVersion)
                    : copy.assets.neverSynced}
                </small>
                {assetSync.warning && (
                  <small className="asset-section__warning">{copy.assets.warnings[assetSync.warning]}</small>
                )}
                {assetSyncActive && assetSync.progress ? (
                  <div className="copy-progress asset-section__progress">
                    <div className="copy-progress__heading">
                      <span><Copy size={15} /> {copy.assets.status[assetSync.status]}</span>
                      <strong>{Math.round(assetPercentage)}%</strong>
                    </div>
                    <div className="copy-progress__track"><i style={{ width: `${assetPercentage}%` }} /></div>
                    <div className="copy-progress__file" title={assetSync.progress.assetName}>
                      {assetSync.progress.assetName}
                    </div>
                  </div>
                ) : (
                  <div className="asset-section__actions">
                    <button
                      type="button"
                      className="text-button"
                      onClick={onVerifyAssets}
                      disabled={busy || !assetSync.enabled}
                    >
                      {copy.assets.verify}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={onRestoreAssets}
                      disabled={busy}
                    >
                      {copy.assets.restore}
                    </button>
                  </div>
                )}
                <label className="asset-section__toggle">
                  <input
                    type="checkbox"
                    checked={assetSync.enabled}
                    disabled={busy || assetSyncActive}
                    onChange={(event) => onToggleAssetSync(event.target.checked)}
                  />
                  <span>{copy.assets.autoSync}</span>
                </label>
              </section>
            )}

            <p className="install-panel__legal">
              {copy.install.legal}
            </p>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
