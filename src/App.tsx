import { useCallback, useEffect, useRef, useState } from "react";
import type { LauncherSnapshot, OperationResult } from "../shared/contracts";
import { GlobalActivityCenter } from "./components/GlobalActivityCenter";
import { InstallPanel } from "./components/InstallPanel";
import { LauncherFooter } from "./components/LauncherFooter";
import { NewsCarousel } from "./components/NewsCarousel";
import { PlayerIdentityPanel } from "./components/PlayerIdentityPanel";
import { UpdateBanner } from "./components/UpdateBanner";
import { hasLauncherUpdate } from "../shared/launcher-update";
import { LauncherUpdatePrompt } from "./components/LauncherUpdatePrompt";
import { WindowChrome } from "./components/WindowChrome";
import { useI18n } from "./i18n";

export default function App() {
  const { locale, copy } = useI18n();
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transientError, setTransientError] = useState<string | null>(null);
  const [detectAttempted, setDetectAttempted] = useState(false);
  const [debugSessionBusy, setDebugSessionBusy] = useState(false);
  const [debugSessionFailed, setDebugSessionFailed] = useState(false);
  const debugSessionInFlight = useRef(false);
  const working = busy || debugSessionBusy || snapshot?.debugSession?.status === "preparing";
  const debugSessionLocked = working || snapshot?.gamePid != null
    || snapshot?.phase === "running" || snapshot?.phase === "launching" || snapshot?.phase === "installing"
    || snapshot?.debugSession?.status === "recording"
    || snapshot?.assetSync.status === "checking" || snapshot?.assetSync.status === "downloading" || snapshot?.assetSync.status === "installing";

  useEffect(() => {
    setTransientError(null);
  }, [locale]);

  useEffect(() => {
    let mounted = true;
    let previousPhase: LauncherSnapshot["phase"] | undefined;
    void window.rotk.getSnapshot().then((value) => {
      if (!mounted) return;
      previousPhase = value.phase;
      setSnapshot(value);
      if (!value.installationRoot) setSetupOpen(true);
      else if (!value.playerIdentity.configured) setIdentityOpen(true);
    });
    const unsubscribe = window.rotk.onSnapshot((value) => {
      const installationFinished = previousPhase === "installing" && value.phase === "ready";
      previousPhase = value.phase;
      setSnapshot(value);
      if (value.phase === "installing") {
        setIdentityOpen(false);
        setSetupOpen(true);
      }
      if (installationFinished && value.installationRoot) {
        setSetupOpen(false);
        if (!value.playerIdentity.configured) setIdentityOpen(true);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // First-run assistance: when the setup panel opens without any selection,
  // ask the main process to discover the Steam client once per session.
  useEffect(() => {
    if (!setupOpen || detectAttempted || !snapshot) return;
    if (snapshot.installationRoot || snapshot.selection.sourceRoot) return;
    if (snapshot.phase === "installing") return;
    setDetectAttempted(true);
    void window.rotk.detectSource();
  }, [setupOpen, detectAttempted, snapshot]);

  // Back from Steam after installing H1Z1: look for the client again.
  useEffect(() => {
    const retry = () => setDetectAttempted(false);
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, []);

  const operationInFlight = useRef(false);
  const perform = useCallback(async (operation: () => Promise<OperationResult<unknown>>) => {
    // A second click while an operation runs must not release `busy` early.
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setTransientError(null);
    try {
      const result = await operation();
      if (!result.ok && !result.cancelled) setTransientError(result.error ?? copy.app.operationFailed);
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  }, [copy.app.operationFailed]);

  const toggleDebugSession = useCallback(async (enabled: boolean) => {
    if (debugSessionInFlight.current || debugSessionLocked) return;
    debugSessionInFlight.current = true;
    setDebugSessionBusy(true);
    setDebugSessionFailed(false);
    try {
      const result = await window.rotk.setDebugSessionEnabled(enabled);
      if (result.ok && result.value) setSnapshot(result.value);
      else if (!result.cancelled) setDebugSessionFailed(true);
    } catch {
      setDebugSessionFailed(true);
    } finally {
      debugSessionInFlight.current = false;
      setDebugSessionBusy(false);
    }
  }, [debugSessionLocked]);

  if (!snapshot) {
    return (
      <main className="boot-screen">
        <img src="./branding/rotk-mark.svg" alt="ROTK" />
        <span>{copy.app.initializing}</span>
      </main>
    );
  }

  const selectSource = () => perform(() => window.rotk.selectSource());
  const selectDestination = () => perform(() => window.rotk.selectDestination());
  const install = () => perform(() => window.rotk.install());
  const play = () => perform(() => window.rotk.play());
  const onPrimary = () => {
    if (hasLauncherUpdate(snapshot.launcherUpdate) || snapshot.updateRequired) {
      setUpdatePromptOpen(true);
      if (!hasLauncherUpdate(snapshot.launcherUpdate)) void window.rotk.checkLauncherUpdate();
    }
    else if (snapshot.canPlay) void play();
    else if (snapshot.installationRoot && !snapshot.playerIdentity.configured) {
      setSetupOpen(false);
      setIdentityOpen(true);
    } else setSetupOpen(true);
  };

  return (
    <main className="launcher-shell">
      <WindowChrome appVersion={snapshot.appVersion} />
      <NewsCarousel updates={snapshot.updates} />
      <GlobalActivityCenter snapshot={snapshot} />
      {(transientError || snapshot.error) && (
        <div className="error-toast" role="alert">
          <strong>{copy.app.operationInterrupted}</strong>
          <span>{snapshot.error ?? transientError}</span>
          <button type="button" aria-label={copy.app.closeError} onClick={() => {
            setTransientError(null);
            void window.rotk.dismissError();
          }}>×</button>
        </div>
      )}
      <UpdateBanner
        snapshot={snapshot}
        busy={working}
        onDownload={() => void perform(() => window.rotk.downloadLauncherUpdate())}
        onInstall={() => void perform(() => window.rotk.installLauncherUpdate())}
      />
      <LauncherFooter
        snapshot={snapshot}
        busy={working}
        onPrimary={onPrimary}
        onSetup={() => {
          setIdentityOpen(false);
          setSetupOpen(true);
        }}
        onIdentity={() => {
          setSetupOpen(false);
          setIdentityOpen(true);
        }}
        onSelectLaunchProfile={(serverId, role) =>
          void perform(() => window.rotk.setLaunchProfile(serverId, role))}
      />
      <LauncherUpdatePrompt
        snapshot={snapshot}
        open={updatePromptOpen}
        busy={working}
        onClose={() => setUpdatePromptOpen(false)}
        onCheck={() => void window.rotk.checkLauncherUpdate()}
        onDownload={() => void perform(() => window.rotk.downloadLauncherUpdate())}
        onInstall={() => void perform(() => window.rotk.installLauncherUpdate())}
      />
      <PlayerIdentityPanel
        snapshot={snapshot}
        open={identityOpen}
        onClose={() => setIdentityOpen(false)}
      />
      <InstallPanel
        snapshot={snapshot}
        open={setupOpen}
        busy={working}
        onClose={() => setSetupOpen(false)}
        onSelectSource={() => void selectSource()}
        onSelectDestination={() => void selectDestination()}
        onChooseDrive={(root) => void perform(() => window.rotk.chooseInstallDrive(root))}
        onInstallWithSteam={() => void perform(() => window.rotk.openSteamInstall())}
        onInstall={() => void install()}
        onCancel={() => void window.rotk.cancelInstall()}
        onVerifyAssets={() => void perform(() => window.rotk.verifyAssets())}
        onRestoreAssets={() => void perform(() => window.rotk.restoreVanillaAssets())}
        onToggleAssetSync={(enabled) => void perform(() => window.rotk.setAssetSyncEnabled(enabled))}
        debugSessionBusy={debugSessionBusy}
        debugSessionFailed={debugSessionFailed}
        debugSessionLocked={debugSessionLocked}
        onToggleDebugSession={(enabled) => void toggleDebugSession(enabled)}
      />
    </main>
  );
}
