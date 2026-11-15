import { Download, HardDrive, KeyRound, LifeBuoy, SlidersHorizontal, Type, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LauncherSnapshot, OperationResult } from "../../shared/contracts";
import { hasLauncherUpdate } from "../../shared/launcher-update";
import { CLOSE_BEHAVIORS, DOWNLOAD_SPEED_LIMITS, GAME_START_BEHAVIORS, type LauncherPreferences } from "../../shared/preferences";
import { assetSyncActive, gameSessionActive } from "../../shared/primary-action";
import { useI18n } from "../i18n";
import { gigabytes } from "../setup-flow";
import { AccountKeys } from "./AccountKeys";
import { FontPicker } from "./FontPicker";
import { ConfirmDialog, Group, Row, Segments, Switch } from "./SettingsControls";

export const SETTINGS_TABS = ["general", "game", "updates", "look", "account", "help"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const ICONS: Record<SettingsTab, LucideIcon> = {
  general: SlidersHorizontal, game: HardDrive, updates: Download, look: Type, account: KeyRound, help: LifeBuoy,
};

interface SettingsPageProps {
  snapshot: LauncherSnapshot;
  busy: boolean;
  tab: SettingsTab;
  onTab(tab: SettingsTab): void;
  onClose(): void;
  /** Opens the install assistant: a first install, or another one elsewhere. */
  onInstall(): void;
  /** Runs an operation of the launcher; a refusal is shown by the window. */
  run(operation: () => Promise<OperationResult<unknown>>): void;
  debugSessionBusy: boolean;
  debugSessionFailed: boolean;
  debugSessionLocked: boolean;
  onToggleDebugSession(enabled: boolean): void;
}

/**
 * The launcher's settings, as a page of the window: between the title bar and
 * the footer, so the server and the main button stay in reach.
 */
export function SettingsPage({
  snapshot, busy, tab, onTab, onClose, onInstall, run, debugSessionBusy, debugSessionFailed, debugSessionLocked, onToggleDebugSession,
}: SettingsPageProps) {
  const { copy, locale, setLocale } = useI18n();
  const t = copy.settings;
  const page = useRef<HTMLElement>(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  useEffect(() => { page.current?.focus(); }, []);
  useEffect(() => {
    // Escape closes what is open over the page first: a modal dialog, or the
    // server menu, which marks the key as handled.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Arrow keys move along the tabs, as in any tab list; Tab then enters the panel.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? SETTINGS_TABS.length - 1
      : (SETTINGS_TABS.indexOf(tab) + step + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    onTab(SETTINGS_TABS[index]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  };

  const preferences = snapshot.preferences;
  const setPreference = (changed: Partial<LauncherPreferences>) => run(() => window.rotk.setPreferences(changed));
  // The game folder cannot change under a game that runs or a client being installed.
  const gameLocked = busy || gameSessionActive(snapshot) || snapshot.phase === "installing";

  const assets = snapshot.assetSync;
  const syncing = assetSyncActive(snapshot);
  const assetPercent = assets.progress && assets.progress.totalBytes > 0
    ? Math.min(100, Math.max(0, (assets.progress.completedBytes / assets.progress.totalBytes) * 100))
    : 0;
  const assetStatus = (
    <>
      <span className="settings-status" data-status={assets.status}>{copy.assets.status[assets.status]}</span>
      {" · "}{assets.packVersion ? copy.assets.packVersion(assets.packVersion) : copy.assets.neverSynced}
    </>
  );

  // Read when the Game tab is shown: walking the folder takes a moment.
  const [install, setInstall] = useState<{ bytes: number; adopted: boolean } | null>(null);
  const installationRoot = snapshot.installationRoot;
  useEffect(() => {
    if (tab !== "game" || !installationRoot) return;
    let current = true;
    setInstall(null);
    void window.rotk.getInstallInfo()
      .then((result) => { if (current && result.ok && result.value) setInstall(result.value); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [tab, installationRoot]);

  // The launcher's own update, said here instead of on a banner over the page.
  const update = snapshot.launcherUpdate;
  const knownUpdate = hasLauncherUpdate(update);
  const updateHint = !knownUpdate ? null
    : update.status === "downloading" ? `${copy.update.downloading} · ${update.progressPercent ?? 0}%`
      : update.status === "downloaded" ? (gameSessionActive(snapshot) ? copy.update.closeGame : copy.update.restartDetail)
        : update.status === "error" ? `${copy.update.failed}${update.error ? ` : ${update.error}` : ""}`
          : copy.update.available(`v${update.availableVersion}`);
  // The player asked for a check and it found no update: say what it answered.
  const [checked, setChecked] = useState(false);
  const checkHint = update.status === "up-to-date" ? t.upToDate : checked && update.status === "idle" ? t.checkFailed : null;

  const debugSession = snapshot.debugSession;
  const debugCopy = copy.diagnostics.debug;
  const debugStatus = debugSessionBusy ? debugCopy.saving
    : debugSessionFailed ? debugCopy.settingFailed
      : debugSession?.status && debugSession.status !== "idle" ? debugCopy[debugSession.status]
        : debugSession?.enabled ? debugCopy.enabled : null;
  const debugError = !debugSessionBusy && (debugSessionFailed || debugSession?.status === "error");
  const debugFailure = !debugSessionBusy && !debugSessionFailed && debugSession?.status === "error" ? debugSession.failure : null;

  const action = (label: string, onClick: () => void, disabled = false, variant = "ghost") => (
    <button type="button" className={`launcher-button${variant ? ` launcher-button--${variant}` : ""}`} onClick={onClick} disabled={disabled}>{label}</button>
  );

  return (
    <section ref={page} tabIndex={-1} className="settings-page" aria-label={t.title}>
      <nav className="settings-nav" aria-label={t.title}>
        <div role="tablist" aria-orientation="vertical" onKeyDown={onTabKey}>
          {SETTINGS_TABS.map((id) => {
            const Icon = ICONS[id];
            return (
              <button key={id} type="button" role="tab" id={`settings-tab-${id}`} aria-selected={tab === id} aria-controls="settings-panel"
                tabIndex={tab === id ? 0 : -1} onClick={() => onTab(id)}>
                <Icon size={17} aria-hidden="true" />{t.tabs[id]}
              </button>
            );
          })}
        </div>
        <small>ROTK Launcher {snapshot.appVersion}</small>
      </nav>

      <div className="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        <header>
          <h2>{t.tabs[tab]}</h2>
          <p>{t.leads[tab]}</p>
        </header>

        {tab === "general" && (
          <>
            <Group>
              <Row title={t.language} hint={t.languageHint}>
                <Segments<typeof locale> label={t.language} value={locale} onChange={setLocale}
                  options={[["en", copy.language.english], ["fr", copy.language.french], ["zh", copy.language.chinese]]} />
              </Row>
            </Group>
            <Group title={t.behaviour}>
              <Row title={t.onClose}>
                <Segments label={t.onClose} value={preferences.closeBehavior} disabled={busy}
                  options={CLOSE_BEHAVIORS.map((id) => [id, t.onCloseOptions[id]] as const)}
                  onChange={(closeBehavior) => setPreference({ closeBehavior })} />
              </Row>
              <Row title={t.onPlay}>
                <Segments label={t.onPlay} value={preferences.gameStartBehavior} disabled={busy}
                  options={GAME_START_BEHAVIORS.map((id) => [id, t.onPlayOptions[id]] as const)}
                  onChange={(gameStartBehavior) => setPreference({ gameStartBehavior })} />
              </Row>
              <Row title={t.notifications} hint={t.notificationsHint}>
                <Switch label={t.notifications} checked={preferences.notifications} disabled={busy} onChange={(notifications) => setPreference({ notifications })} />
              </Row>
            </Group>
          </>
        )}

        {tab === "game" && (
          <>
            <Group title={t.location}>
              <Row
                title={installationRoot ? <code title={installationRoot}>{installationRoot}</code> : t.notInstalled}
                hint={installationRoot ? t.installElsewhereHint : undefined}
              >
                {action(installationRoot ? t.installElsewhere : t.installNow, onInstall, snapshot.phase === "installing")}
              </Row>
              {installationRoot && (
                <>
                  <Row title={t.openFolder}>{action(t.open, () => run(() => window.rotk.openInstallFolder()))}</Row>
                  <Row title={t.diskUse}>
                    <code aria-live="polite">{install === null ? t.computing : t.gigabytes(gigabytes(install.bytes, locale))}</code>
                  </Row>
                </>
              )}
            </Group>
            {installationRoot && (
              <>
                <Group title={t.gameFiles}>
                  <Row
                    title={t.files}
                    hint={<>
                      {assetStatus}<br />
                      {assets.warning ? copy.assets.warnings[assets.warning] : t.filesHint}
                      {syncing && assets.progress && (
                        <span className="setup-track settings-row__track" role="progressbar" aria-label={copy.assets.updating} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(assetPercent)}>
                          <i style={{ width: `${assetPercent}%` }} />
                        </span>
                      )}
                    </>}
                  >
                    {action(t.verify, () => run(() => window.rotk.verifyAssets()), busy || syncing || !assets.enabled)}
                  </Row>
                  {/* A game used where it already was has no original to be repaired from. */}
                  <Row title={t.repair} hint={install?.adopted ? t.repairAdoptedHint : t.repairHint}>
                    {action(t.repairButton, () => run(() => window.rotk.repairGame()), gameLocked || syncing || install?.adopted === true)}
                  </Row>
                </Group>
                <details className="settings-advanced">
                  <summary>{t.advanced}</summary>
                  <Group>
                    <Row title={t.restore} hint={t.restoreHint}>
                      {action(copy.assets.restore, () => run(() => window.rotk.restoreVanillaAssets()), busy || syncing)}
                    </Row>
                    <Row title={t.uninstall} hint={install?.adopted ? t.uninstallAdoptedHint : t.uninstallHint}>
                      {/* What uninstalling does to the folder is not known before the answer. */}
                      {action(t.uninstallButton, () => setConfirmingUninstall(true), gameLocked || syncing || install === null, "danger")}
                    </Row>
                  </Group>
                </details>
              </>
            )}
          </>
        )}

        {tab === "updates" && (
          <>
            <Group title={t.launcher}>
              <Row title={t.version(snapshot.appVersion)} hint={!updateHint ? checkHint && <span role="status">{checkHint}</span> : (
                <>
                  <span className="settings-status" data-status={update.status === "error" ? "error" : "warning"}>{updateHint}</span>
                  {update.status === "downloading" && (
                    <span className="setup-track settings-row__track" role="progressbar" aria-label={copy.update.downloading} aria-valuemin={0} aria-valuemax={100} aria-valuenow={update.progressPercent ?? 0}>
                      <i style={{ width: `${update.progressPercent ?? 0}%` }} />
                    </span>
                  )}
                </>
              )}>
                {update.status === "downloaded"
                  ? action(copy.update.restart, () => run(() => window.rotk.installLauncherUpdate()), busy || gameSessionActive(snapshot), "")
                  : knownUpdate && update.status !== "downloading"
                    ? action(update.status === "error" ? copy.update.retry : copy.update.download, () => run(() => window.rotk.downloadLauncherUpdate()), busy, "")
                    // The answer comes once the check is over, found or not.
                    : action(copy.update.check, () => {
                      setChecked(false);
                      void window.rotk.checkLauncherUpdate().finally(() => setChecked(true));
                    }, update.status === "checking" || update.status === "downloading")}
              </Row>
              <Row title={copy.update.autoDownload}>
                <Switch label={copy.update.autoDownload} checked={snapshot.launcherUpdateAutoDownload} disabled={busy}
                  onChange={(enabled) => run(() => window.rotk.setLauncherUpdateAutoDownload(enabled))} />
              </Row>
            </Group>
            <Group title={t.gameFiles}>
              <Row title={copy.assets.autoSync} hint={<>{assetStatus}<br />{copy.assets.description}</>}>
                <Switch label={copy.assets.autoSync} checked={assets.enabled} disabled={busy || syncing}
                  onChange={(enabled) => run(() => window.rotk.setAssetSyncEnabled(enabled))} />
              </Row>
              <Row title={t.speedLimit}>
                <Segments label={t.speedLimit} value={preferences.downloadSpeedLimit} disabled={busy}
                  options={DOWNLOAD_SPEED_LIMITS.map((limit) => [limit, limit === 0 ? t.noLimit : t.megabytesPerSecond(limit)] as const)}
                  onChange={(downloadSpeedLimit) => setPreference({ downloadSpeedLimit })} />
              </Row>
            </Group>
            <Group>
              <Row title={t.releaseNotes} hint={t.releaseNotesHint}>
                {action(t.open, () => run(() => window.rotk.openWebsite("/updates")))}
              </Row>
            </Group>
          </>
        )}

        {tab === "look" && (
          <FontPicker
            playerFont={snapshot.playerFont}
            busy={busy}
            onSelect={(id) => run(() => window.rotk.setPlayerFont(id))}
            onSelectLauncher={(id) => run(() => window.rotk.setLauncherFont(id))}
          />
        )}

        {tab === "account" && <AccountKeys snapshot={snapshot} />}

        {tab === "help" && (
          <>
            <Group>
              <Row title={t.report} hint={t.reportHint}>{action(t.open, () => run(() => window.rotk.openWebsite("/support")))}</Row>
              <Row title={t.discord} hint={t.discordHint}>{action(t.open, () => run(() => window.rotk.openDiscord()))}</Row>
            </Group>
            <Group title={debugCopy.title}>
              <div aria-busy={debugSessionBusy || debugSession?.status === "preparing"}>
                <Row title={debugCopy.enable} hint={<span id="debug-session-description">{debugCopy.description}</span>}>
                  <Switch label={debugCopy.enable} describedBy="debug-session-description" checked={debugSession?.enabled ?? false} disabled={debugSessionLocked} onChange={onToggleDebugSession} />
                </Row>
                {debugStatus && (
                  <p className={`settings-note${debugError ? " is-error" : ""}`} role={debugError ? "alert" : "status"}>
                    {debugStatus}
                    {debugSession?.status === "ready" && debugSession.fileName && <><br /><code>{debugSession.fileName}</code></>}
                    {debugFailure && <><br />{debugCopy.failure[debugFailure.reason]}{debugFailure.httpStatus ? ` (HTTP ${debugFailure.httpStatus})` : ""}</>}
                  </p>
                )}
              </div>
            </Group>
            <Group>
              <Row title={t.versionInfo} hint={t.versionInfoHint}>
                <code className="settings-copyable">
                  ROTK Launcher {snapshot.appVersion} · {assets.packVersion ? copy.assets.packVersion(assets.packVersion) : copy.assets.neverSynced} · {snapshot.runtime.label} · {locale}
                </code>
              </Row>
              <Row title={t.logs} hint={t.logsHint}>{action(t.open, () => run(() => window.rotk.openLogsFolder()))}</Row>
            </Group>
            <p className="settings-legal">{copy.install.legal}</p>
          </>
        )}
      </div>

      {confirmingUninstall && installationRoot && install && (
        <ConfirmDialog
          title={t.uninstallConfirm.title}
          detail={installationRoot}
          // A game used where it already was is the player's own copy of H1Z1: it stays on the disk.
          message={install.adopted ? t.uninstallConfirm.forget : t.uninstallConfirm.remove}
          confirmLabel={t.uninstallButton}
          cancelLabel={t.uninstallConfirm.cancel}
          onCancel={() => setConfirmingUninstall(false)}
          onConfirm={() => {
            setConfirmingUninstall(false);
            run(() => window.rotk.uninstallGame());
          }}
        />
      )}
    </section>
  );
}
