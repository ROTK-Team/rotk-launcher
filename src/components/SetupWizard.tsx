import { Check, CircleAlert, Download, ExternalLink, Eye, EyeOff, FolderOpen, HardDrive, KeyRound, LoaderCircle, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InstallDrive, LauncherSnapshot } from "../../shared/contracts";
import type { LaunchProfileId } from "../../shared/launch-profile";
import { isValidPlayerKey, normalizePlayerKey, PLAYER_KEY_HEX_LENGTH } from "../../shared/player-key";
import { languageWasChosen, rememberLanguageChosen, useI18n } from "../i18n";
import { LanguageFlag } from "./LanguageFlag";
import { gigabytes, installPercent, setupStep, setupStepList, useMinutesLeft, type SetupStep } from "../setup-flow";

interface SetupWizardProps {
  snapshot: LauncherSnapshot;
  busy: boolean;
  /** The answer to the player's last click first, then what the main process still holds. */
  error: string | null;
  /** The first look for H1Z1 on this PC is running. */
  searching: boolean;
  /** An installed player prepares another installation: see setupStep. */
  relocating: boolean;
  onClose(): void;
  onDismissError(): void;
  onSelectSource(): void;
  onSelectDestination(): void;
  onChooseDrive(root: string): void;
  onInstallWithSteam(): void;
  onInstall(): void;
  onCancel(): void;
  onSaveKey(profile: LaunchProfileId, playerKey: string): void;
  onPlay(): void;
}

/** The language is asked before the steps, on a first install only. */
type Screen = SetupStep | "language";

const GB = 1024 ** 3;
const PHASES = ["scanning", "copying", "verifying", "configuring", "finalizing"] as const;

/**
 * The install journey, one question per screen: H1Z1, location, copy, account.
 * It covers the window under the title bar; the copy, the key and the end
 * follow the launcher's state, the screens before the copy follow the player.
 */
export function SetupWizard({
  snapshot, busy, error, searching, relocating,
  onClose, onDismissError, onSelectSource, onSelectDestination, onChooseDrive, onInstallWithSteam, onInstall, onCancel, onSaveKey, onPlay,
}: SetupWizardProps) {
  const { copy, locale, setLocale } = useI18n();
  const t = copy.install;
  const step = setupStep(snapshot, relocating);
  const installing = step === "copy";
  // A client that is already outside Steam is used where it is: no location screen.
  const beforeCopy: SetupStep = snapshot.selection.sourceKind === "direct" ? "h1z1" : "location";
  // A new player is asked for the language before anything else, once.
  const [askLanguage] = useState(() => !snapshot.installationRoot && !relocating && !languageWasChosen());
  const [screen, setScreen] = useState<Screen>(askLanguage ? "language" : step === "location" ? "h1z1" : step);
  useEffect(() => {
    setScreen((current) => {
      if (step === "copy" || step === "key" || step === "done") return step;
      if (current === "language") return current;
      // The copy stopped: stay on its screen while there is an error to read.
      if (current === "copy") return error ? "copy" : beforeCopy;
      return step === "h1z1" || current === "key" || current === "done" ? "h1z1" : current;
    });
  }, [step, error, beforeCopy]);

  const dialog = useRef<HTMLElement>(null);
  // The buttons of a screen go away with it: the keyboard stays in the assistant.
  useEffect(() => { dialog.current?.focus(); }, [screen]);
  useEffect(() => {
    if (installing) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [installing, onClose]);

  const { sourceRoot, sourceKind, destinationRoot, destinationRecommended } = snapshot.selection;
  const direct = sourceKind === "direct";
  const [drives, setDrives] = useState<InstallDrive[]>([]);
  useEffect(() => {
    if (sourceKind !== "copy-required") return;
    let current = true;
    window.rotk.listInstallDrives()
      .then((value) => { if (current) setDrives(value); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [sourceKind, destinationRoot]);
  const [steamAsked, setSteamAsked] = useState(false);

  const progress = snapshot.progress;
  const percent = installPercent(progress);
  const minutesLeft = useMinutesLeft(progress);
  const phaseAt = progress ? PHASES.indexOf(progress.phase) : -1;

  const { serverId, role } = snapshot.playerIdentity;
  const websiteHost = new URL(snapshot.runtime.websiteOrigin).host;
  const [draft, setDraft] = useState("");
  const [invalidKey, setInvalidKey] = useState(false);
  // The key is a secret: hidden as in the settings, shown on request.
  const [keyVisible, setKeyVisible] = useState(false);
  const saveKey = () => {
    if (!isValidPlayerKey(draft)) return setInvalidKey(true);
    onSaveKey(`${serverId}:${role}`, normalizePlayerKey(draft));
  };

  const steps: Exclude<Screen, "done">[] = [...(askLanguage ? ["language" as const] : []), ...setupStepList(snapshot, relocating)];
  const failed = screen === "copy" && !installing;
  const at = screen === "done" ? steps.length : Math.max(0, steps.indexOf(screen));
  // A folder picked by hand is not `<drive>\Games\ROTK`.
  const customDestination = destinationRoot !== null && !/^[A-Z]:\\Games\\ROTK$/i.test(destinationRoot);
  // The room left on the disk of a folder picked by hand, when it is one of the listed disks.
  const customDrive = customDestination ? drives.find((drive) => drive.root === destinationRoot.slice(0, 3).toUpperCase()) : undefined;
  const missing = screen === "h1z1" && !sourceRoot && !searching;
  const heading = {
    language: t.languageTitle,
    h1z1: missing ? t.h1z1Missing : t.title,
    location: t.locationTitle,
    copy: failed ? t.failedTitle : t.copyTitle,
    key: t.keyTitle,
    done: t.doneTitle,
  }[screen];
  const lead = {
    language: t.languageLead,
    h1z1: relocating ? copy.settings.installElsewhereHint : missing ? t.h1z1MissingDetail : t.lead,
    location: t.locationLead,
    copy: failed ? t.failedKept : null,
    key: t.keyLead,
    done: t.doneLead,
  }[screen];

  return (
    <section ref={dialog} tabIndex={-1} className="setup-wizard" role="dialog" aria-modal="true" aria-labelledby="setup-wizard-title">
      <ol className="setup-steps" aria-label={t.title}>
        {steps.map((id, index) => (
          <li key={id} data-state={index < at ? "done" : index === at ? "current" : "todo"} aria-current={index === at ? "step" : undefined}>
            <span>{index < at ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
            {t.steps[id]}
          </li>
        ))}
      </ol>

      <div className="setup-body">
        {screen !== "done" && <span className="eyebrow">{t.stepOf(at + 1, steps.length)}</span>}
        <h2 id="setup-wizard-title">{heading}</h2>
        {lead && <p className="setup-lead">{lead}</p>}

        {error && !installing && (
          <div className="setup-error" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <p>{error}</p>
            <button type="button" aria-label={copy.app.closeError} onClick={onDismissError}><X size={16} /></button>
          </div>
        )}

        {screen === "language" && (
          <div className="setup-drives setup-languages" role="radiogroup" aria-label={t.languageTitle}>
            {(["en", "fr", "zh"] as const).map((id) => (
              <button key={id} type="button" role="radio" aria-checked={locale === id} className="setup-drive" onClick={() => setLocale(id)}>
                <LanguageFlag locale={id} />
                <strong>{id === "fr" ? copy.language.french : id === "zh" ? copy.language.chinese : copy.language.english}</strong>
              </button>
            ))}
          </div>
        )}

        {screen === "h1z1" && sourceRoot && (
          <div className="setup-found">
            <span className="setup-found__check" aria-hidden="true"><Check size={20} /></span>
            <div>
              <strong>{direct ? t.directFound : t.h1z1Found}</strong>
              <code title={sourceRoot}>{sourceRoot}</code>
              <p>{direct ? t.directDetail : t.h1z1FoundDetail}</p>
              <button type="button" className="launcher-link" onClick={onSelectSource} disabled={busy}>{t.otherFolderLink}</button>
            </div>
          </div>
        )}
        {screen === "h1z1" && !sourceRoot && searching && (
          <p className="setup-note setup-note--plain" role="status"><LoaderCircle size={18} className="setup-spin" aria-hidden="true" /> {t.searching}</p>
        )}
        {missing && (
          <>
            <div className="setup-choices">
              <section className="setup-choice">
                <Download size={20} aria-hidden="true" />
                <strong>{t.noGame}</strong>
                <p>{t.noGameDetail}</p>
                <button type="button" className="launcher-button" onClick={() => { setSteamAsked(true); onInstallWithSteam(); }} disabled={busy}>{t.steamButton}</button>
              </section>
              <section className="setup-choice">
                <FolderOpen size={20} aria-hidden="true" />
                <strong>{t.haveGame}</strong>
                <p>{t.haveGameDetail}</p>
                <button type="button" className="launcher-button launcher-button--ghost" onClick={onSelectSource} disabled={busy}>{t.chooseFolder}</button>
              </section>
            </div>
            {steamAsked && (
              <p className="setup-note" role="status"><LoaderCircle size={16} className="setup-spin" aria-hidden="true" /> {t.steamWaiting}</p>
            )}
          </>
        )}

        {screen === "location" && (
          <>
            <div className="setup-drives" role="radiogroup" aria-label={t.locationTitle}>
              {drives.map((drive) => {
                const selected = !customDestination && destinationRoot?.slice(0, 3).toUpperCase() === drive.root;
                return (
                  <button key={drive.root} type="button" role="radio" aria-checked={selected} className="setup-drive" disabled={busy} onClick={() => onChooseDrive(drive.root)}>
                    <HardDrive size={18} aria-hidden="true" />
                    <strong>{drive.root.slice(0, 2)}</strong>
                    <small>{t.free(Math.floor(drive.freeBytes / GB))}</small>
                    {selected && destinationRecommended && <em>{t.recommended}</em>}
                  </button>
                );
              })}
              <button type="button" role="radio" aria-checked={customDestination} className="setup-drive setup-drive--other" disabled={busy} onClick={onSelectDestination}>
                <FolderOpen size={18} aria-hidden="true" />
                <strong>{t.otherFolder}</strong>
                <small>{customDrive ? t.free(Math.floor(customDrive.freeBytes / GB)) : t.otherFolderDetail}</small>
              </button>
            </div>
            {destinationRoot ? (
              <div className="setup-path">
                <FolderOpen size={20} aria-hidden="true" />
                <p>
                  <span>{t.installsIn}</span>
                  <code title={destinationRoot}>{destinationRoot}</code>
                  <small>{t.subfolder}</small>
                </p>
                {customDestination && <button type="button" className="launcher-link" disabled={busy} onClick={onSelectDestination}>{t.changeFolder}</button>}
              </div>
            ) : drives.length === 0 && (
              <p className="setup-note setup-note--warning" role="status"><CircleAlert size={16} aria-hidden="true" /> {t.noDrive}</p>
            )}
          </>
        )}

        {screen === "copy" && installing && (
          <div className="setup-copy">
            <div className="setup-copy__head">
              <span>{progress ? t.phases[progress.phase] : t.starting}</span>
              <strong>{Math.round(percent)}%</strong>
            </div>
            <div className="setup-track" role="progressbar" aria-label={t.copyTitle} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
              <i style={{ width: `${percent}%` }} />
            </div>
            <p className="setup-copy__meta">
              {progress && (progress.phase === "copying" || progress.phase === "verifying") && progress.totalBytes > 0 && (
                <span>{t.gigabytes(gigabytes(progress.completedBytes, locale), gigabytes(progress.totalBytes, locale))}</span>
              )}
              {minutesLeft !== null && <span>{minutesLeft <= 1 ? t.remainingSoon : t.remaining(minutesLeft)}</span>}
            </p>
            <ol className="setup-phases">
              {PHASES.map((phase, index) => (
                <li key={phase} data-state={index < phaseAt ? "done" : index === phaseAt ? "current" : "todo"}>
                  {index < phaseAt ? <Check size={13} aria-hidden="true" /> : <i aria-hidden="true" />}{t.phases[phase]}
                </li>
              ))}
            </ol>
            {!direct && <p className="setup-copy__leave">{t.canLeave}</p>}
          </div>
        )}

        {screen === "key" && (
          <form className="setup-key" onSubmit={(event) => { event.preventDefault(); saveKey(); }}>
            <p className="setup-key__path">{copy.identity.keyHints[role](websiteHost)}</p>
            <button type="button" className="launcher-button launcher-button--ghost" onClick={() => void window.rotk.openWebsite("/login")}>
              {copy.identity.openAccount(websiteHost)} <ExternalLink size={14} aria-hidden="true" />
            </button>
            <label className="key-field">
              <KeyRound size={18} aria-hidden="true" />
              <input
                type={keyVisible ? "text" : "password"}
                value={draft}
                maxLength={PLAYER_KEY_HEX_LENGTH}
                onChange={(event) => { setDraft(event.target.value); setInvalidKey(false); }}
                placeholder={t.keyPlaceholder}
                aria-label={`${copy.identity.keyLabels[role]} — ${snapshot.runtime.label}`}
                aria-invalid={invalidKey}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
              />
              <button type="button" className="key-field__tool" aria-label={keyVisible ? copy.identity.hide : copy.identity.show} title={keyVisible ? copy.identity.hide : copy.identity.show} onClick={() => setKeyVisible((shown) => !shown)}>
                {keyVisible ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
              <button type="submit" className="launcher-button" disabled={busy || draft.trim() === ""}>{t.saveKey}</button>
            </label>
            {invalidKey && <p className="setup-key__invalid" role="alert">{copy.identity.invalid}</p>}
          </form>
        )}
      </div>

      <footer className="setup-actions">
        {installing
          ? <button type="button" className="launcher-button launcher-button--quiet" onClick={onCancel}>{t.cancel}</button>
          : <button type="button" className="launcher-button launcher-button--quiet" onClick={onClose}>{screen === "done" ? t.close : t.later}</button>}
        <span />
        {(screen === "location" || failed) && (
          <button type="button" className="launcher-button launcher-button--ghost" onClick={() => { onDismissError(); setScreen(failed ? beforeCopy : "h1z1"); }}>{t.back}</button>
        )}
        {screen === "language" && (
          <button type="button" className="launcher-button launcher-button--big" onClick={() => { rememberLanguageChosen(); setScreen(step === "location" ? "h1z1" : step); }}>{t.next}</button>
        )}
        {screen === "h1z1" && sourceRoot && (direct
          ? <button type="button" className="launcher-button launcher-button--big" onClick={onInstall} disabled={busy}>{t.adopt}</button>
          : <button type="button" className="launcher-button launcher-button--big" onClick={() => setScreen("location")}>{t.next}</button>)}
        {screen === "location" && <button type="button" className="launcher-button launcher-button--big" onClick={onInstall} disabled={busy || !destinationRoot}>{t.install}</button>}
        {failed && <button type="button" className="launcher-button launcher-button--big" onClick={onInstall} disabled={busy}>{t.retry}</button>}
        {screen === "done" && (
          <button type="button" className="launcher-button launcher-button--big" disabled={!snapshot.canPlay || busy} onClick={onPlay}>
            {copy.footer.play} <Play size={18} fill="currentColor" aria-hidden="true" />
          </button>
        )}
      </footer>
    </section>
  );
}
