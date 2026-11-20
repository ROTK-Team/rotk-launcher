import { useCallback, useEffect, useRef, useState } from "react";
import { applyLauncherFont } from "./player-font-faces";
import type { LauncherSnapshot, OperationResult } from "../shared/contracts";
import { GlobalActivityCenter } from "./components/GlobalActivityCenter";
import { HomeBanner } from "./components/HomeBanner";
import { LauncherFooter } from "./components/LauncherFooter";
import { NewsCarousel } from "./components/NewsCarousel";
import { SettingsPage, type SettingsTab } from "./components/SettingsPage";
import { SetupWizard } from "./components/SetupWizard";
import { UpdateBanner } from "./components/UpdateBanner";
import { hasLauncherUpdate } from "../shared/launcher-update";
import { assetSyncActive, gameSessionActive, primaryAction } from "../shared/primary-action";
import { LauncherUpdatePrompt } from "./components/LauncherUpdatePrompt";
import { WindowChrome } from "./components/WindowChrome";
import { useI18n } from "./i18n";
import { gameInstalled } from "./setup-flow";

const BOOT_SLOW_AFTER_MS = 8_000;

export default function App() {
  const { locale, copy } = useI18n();
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  // One at a time over the home page: the install assistant or the settings.
  const [view, setView] = useState<"setup" | "settings" | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  // An installed player prepares another installation from the settings.
  const [relocating, setRelocating] = useState(false);
  // Read by the listener below, which is set up once.
  const viewNow = useRef(view);
  viewNow.current = view;
  const [searching, setSearching] = useState(false);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transientError, setTransientError] = useState<string | null>(null);
  const [detectAttempted, setDetectAttempted] = useState(false);
  // "slow" after a few seconds without a first snapshot, "failed" when the
  // main process answered with an error.
  const [bootState, setBootState] = useState<"starting" | "slow" | "failed">("starting");
  const [debugSessionBusy, setDebugSessionBusy] = useState(false);
  const [debugSessionFailed, setDebugSessionFailed] = useState(false);
  const debugSessionInFlight = useRef(false);
  const working = busy || debugSessionBusy || snapshot?.debugSession?.status === "preparing";
  const debugSessionLocked = working || snapshot?.phase === "installing"
    || snapshot?.debugSession?.status === "recording"
    || (snapshot ? gameSessionActive(snapshot) || assetSyncActive(snapshot) : false);

  useEffect(() => {
    setTransientError(null);
  }, [locale]);

  const launcherFont = snapshot?.playerFont.launcherSelected;
  useEffect(() => {
    if (launcherFont) applyLauncherFont(launcherFont);
  }, [launcherFont]);

  useEffect(() => {
    let mounted = true;
    let previousPhase: LauncherSnapshot["phase"] | undefined;
    // Where the game was before the copy under way.
    let rootBeforeCopy: string | null = null;
    // A repair started from the settings: the player comes back to them.
    let backToSettings = false;
    // A drive that is slow to wake up under the game folder can hold the
    // first snapshot for a while: say so instead of a logo with no end.
    const slow = setTimeout(() => { if (mounted) setBootState((state) => state === "starting" ? "slow" : state); }, BOOT_SLOW_AFTER_MS);
    void window.rotk.getSnapshot().then((value) => {
      if (!mounted) return;
      previousPhase = value.phase;
      rootBeforeCopy = value.installationRoot;
      setSnapshot(value);
      // The assistant ends with the account key: it also opens for a missing key.
      if (!value.installationRoot || !value.playerIdentity.configured) setView("setup");
    }).catch(() => { if (mounted) setBootState("failed"); })
      .finally(() => clearTimeout(slow));
    const unsubscribe = window.rotk.onSnapshot((value) => {
      const copyStarted = previousPhase !== "installing" && value.phase === "installing";
      const copyEnded = previousPhase === "installing" && value.phase !== "installing";
      previousPhase = value.phase;
      setSnapshot(value);
      // The copy is followed in the assistant, which shows it and can cancel it.
      if (copyStarted) backToSettings = viewNow.current === "settings";
      if (value.phase === "installing") setView("setup");
      if (copyEnded && backToSettings) setView("settings");
      // A copy cancelled or failed over an installed game comes back to `ready`
      // too: only a game that moved ends the move. The assistant stays open, its
      // next screen is the key, or the end.
      if (copyEnded && value.phase === "ready" && value.installationRoot !== rootBeforeCopy) setRelocating(false);
      if (value.phase !== "installing") rootBeforeCopy = value.installationRoot;
    });
    return () => {
      mounted = false;
      clearTimeout(slow);
      unsubscribe();
    };
  }, []);

  // First-run assistance: when the assistant opens without any selection,
  // ask the main process to discover the Steam client once per session.
  const firstDetection = useRef(true);
  useEffect(() => {
    if (view !== "setup" || detectAttempted || !snapshot) return;
    if ((gameInstalled(snapshot) && !relocating) || snapshot.selection.sourceRoot) return;
    if (snapshot.phase === "installing") return;
    setDetectAttempted(true);
    // Only the first look is announced: the ones made when the window gets
    // the focus back must not blink over the choices.
    setSearching(firstDetection.current);
    firstDetection.current = false;
    void window.rotk.detectSource().finally(() => setSearching(false));
  }, [view, relocating, detectAttempted, snapshot]);

  const operationInFlight = useRef(false);
  // Back from Steam after installing H1Z1: look for the client again.
  useEffect(() => {
    const retry = () => setDetectAttempted(false);
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, []);

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
        {/* The window has no frame: without this bar it could be neither moved nor closed. */}
        <WindowChrome ready={false} />
        <img src="./branding/rotk-mark.svg" alt="ROTK" />
        <span>{copy.app.initializing}</span>
        {bootState !== "starting" && (
          <small role="status">{bootState === "slow" ? copy.app.initializingSlow : copy.app.initializingFailed}</small>
        )}
      </main>
    );
  }

  const selectSource = () => perform(() => window.rotk.selectSource());
  const selectDestination = () => perform(() => window.rotk.selectDestination());
  const install = () => perform(async () => {
    const result = await window.rotk.install();
    // Installed again in the same folder: the move is over all the same.
    if (result.ok) setRelocating(false);
    return result;
  });
  const play = () => perform(() => window.rotk.play());
  // The answer to the player's last click comes first: an older error still
  // held by the main process must not hide it.
  const error = transientError ?? snapshot.error;
  // Close what is shown, nothing else: an error or a notice behind it then
  // takes its place instead of vanishing unread. The main process often holds
  // the same text as the answer just shown.
  const dismissError = () => {
    if (transientError === null || transientError === snapshot.error) void window.rotk.dismissError();
    setTransientError(null);
  };
  const closeView = () => {
    setView(null);
    setRelocating(false);
  };
  const notice = error ? null : snapshot.notice;
  // Same decision as the button's label: the click can no longer do
  // something else than what the button says.
  const onPrimary = () => {
    const action = primaryAction(snapshot, working);
    if (!action.enabled) return;
    if (action.kind === "update") {
      setUpdatePromptOpen(true);
      if (!hasLauncherUpdate(snapshot.launcherUpdate)) void window.rotk.checkLauncherUpdate();
    } else if (action.kind === "play") void play();
    // Installing and adding the key are two screens of the same assistant.
    else if (action.kind === "add-key" || action.kind === "setup") {
      setRelocating(false);
      setView("setup");
    }
  };

  return (
    <main className="launcher-shell">
      <WindowChrome
        ready
        page={view === "settings" ? "settings" : "home"}
        // Leaving the assistant by this bar gives up the move it was preparing.
        onPage={(page) => {
          setRelocating(false);
          setView(page === "settings" ? "settings" : null);
        }}
        // The copy cannot be left: the assistant stays until it is over or cancelled.
        locked={snapshot.phase === "installing"}
      />
      {/* What a page covers must not be reached with the keyboard. */}
      <div className="launcher-home" inert={view !== null}>
        {/* A line of the home page: under a page it would sit on that page's title. */}
        {view === null && <HomeBanner banner={snapshot.banner} events={snapshot.events} updates={snapshot.updates} />}
        <NewsCarousel updates={snapshot.updates} featured={snapshot.featured} backgrounds={snapshot.backgrounds} />
        {/* Drawn over the window: under a page it would sit on that page. */}
        {view === null && <GlobalActivityCenter snapshot={snapshot} />}
      </div>
      {/* The assistant shows the error itself, next to what caused it. */}
      {(error || notice) && view !== "setup" && (
        <div className="error-toast" role={error ? "alert" : "status"}>
          <strong>{error ? copy.app.operationInterrupted : copy.app.notice}</strong>
          <span>{error ?? notice}</span>
          <button type="button" aria-label={copy.app.closeError} onClick={dismissError}>×</button>
        </div>
      )}
      {/* The settings say it themselves, under Updates; the assistant is not the moment. */}
      {view === null && (
        <UpdateBanner
          snapshot={snapshot}
          busy={working}
          onDownload={() => void perform(() => window.rotk.downloadLauncherUpdate())}
          onInstall={() => void perform(() => window.rotk.installLauncherUpdate())}
        />
      )}
      <div className="launcher-home" inert={view === "setup"}>
      <LauncherFooter
        snapshot={snapshot}
        busy={working}
        onPrimary={onPrimary}
        onStopGame={() => void perform(() => window.rotk.stopGame())}
        onSelectLaunchProfile={(serverId, role) =>
          void perform(() => window.rotk.setLaunchProfile(serverId, role))}
      />
      </div>
      <LauncherUpdatePrompt
        snapshot={snapshot}
        open={updatePromptOpen}
        busy={working}
        onClose={() => setUpdatePromptOpen(false)}
        onCheck={() => void window.rotk.checkLauncherUpdate()}
        onDownload={() => void perform(() => window.rotk.downloadLauncherUpdate())}
        onInstall={() => void perform(() => window.rotk.installLauncherUpdate())}
      />
      {view === "setup" && (
        <SetupWizard
          snapshot={snapshot}
          busy={working}
          error={error}
          searching={searching}
          relocating={relocating}
          onClose={closeView}
          onDismissError={dismissError}
          onSelectSource={() => void selectSource()}
          onSelectDestination={() => void selectDestination()}
          onChooseDrive={(root) => void perform(() => window.rotk.chooseInstallDrive(root))}
          onInstallWithSteam={() => void perform(() => window.rotk.openSteamInstall())}
          onOpenSteamConsole={() => void window.rotk.openSteamConsole()}
          onInstall={() => void install()}
          onCancel={() => void window.rotk.cancelInstall()}
          onSaveKey={(profile, playerKey) => void perform(() => window.rotk.setPlayerKey(profile, playerKey))}
          onPlay={() => {
            closeView();
            void play();
          }}
        />
      )}
      {view === "settings" && (
        <SettingsPage
          snapshot={snapshot}
          busy={working}
          tab={settingsTab}
          onTab={setSettingsTab}
          onClose={closeView}
          onInstall={() => {
            setRelocating(gameInstalled(snapshot));
            setView("setup");
          }}
          run={(operation) => void perform(operation)}
          debugSessionBusy={debugSessionBusy}
          debugSessionFailed={debugSessionFailed}
          debugSessionLocked={debugSessionLocked}
          onToggleDebugSession={(enabled) => void toggleDebugSession(enabled)}
        />
      )}
    </main>
  );
}
