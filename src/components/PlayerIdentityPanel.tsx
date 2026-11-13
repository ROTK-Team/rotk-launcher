import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { LauncherSnapshot, OperationResult, PlayerIdentitySummary } from "../../shared/contracts";
import {
  LAUNCH_PROFILE_IDS,
  SERVER_IDS,
  type LaunchProfileId,
  type PlayerRole,
  type ServerId,
} from "../../shared/launch-profile";
import { isValidPlayerKey, normalizePlayerKey, PLAYER_KEY_HEX_LENGTH } from "../../shared/player-key";
import { gameSessionActive } from "../../shared/primary-action";
import { useI18n, type Copy as CopyText } from "../i18n";

interface PlayerIdentityPanelProps {
  snapshot: LauncherSnapshot;
  open: boolean;
  onClose(): void;
}

type Feedback = { tone: "success" | "error"; text: string } | null;
type Drafts = Record<LaunchProfileId, string>;

/** The key almost every player needs; the other three are behind the fold. */
const PRIMARY_PROFILE: LaunchProfileId = "game2:player";
const SECONDARY_PROFILES: LaunchProfileId[] = LAUNCH_PROFILE_IDS.filter(
  (profile) => profile !== PRIMARY_PROFILE,
);

function draftsFrom(identity: PlayerIdentitySummary): Drafts {
  return Object.fromEntries(
    LAUNCH_PROFILE_IDS.map((profile) => [profile, identity.keys[profile] ?? ""]),
  ) as Drafts;
}

function serverOf(profile: LaunchProfileId): ServerId {
  return profile.split(":")[0] as ServerId;
}

function roleOf(profile: LaunchProfileId): PlayerRole {
  return profile.split(":")[1] as PlayerRole;
}

function websiteHost(websiteOrigin: string): string {
  try {
    return new URL(websiteOrigin).host;
  } catch {
    return websiteOrigin;
  }
}

export function PlayerIdentityPanel({ snapshot, open, onClose }: PlayerIdentityPanelProps) {
  const { copy } = useI18n();
  const identity = snapshot.playerIdentity;
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(identity));
  const [visible, setVisible] = useState<LaunchProfileId | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const locked = gameSessionActive(snapshot);
  const storedKeys = LAUNCH_PROFILE_IDS.map((profile) => identity.keys[profile]).join("|");
  const extraKeyCount = SECONDARY_PROFILES.filter((profile) => identity.keys[profile] !== null).length;
  const hosts = useMemo(
    () => Object.fromEntries(snapshot.runtime.servers.map((server) => [
      server.id,
      websiteHost(server.websiteOrigin),
    ])) as Record<ServerId, string>,
    [snapshot.runtime.servers],
  );

  // The main process owns the stored keys; the fields follow it rather than
  // holding an independent copy that could drift from what a launch would use.
  useEffect(() => {
    setDrafts(draftsFrom(identity));
  }, [storedKeys]);

  useEffect(() => {
    if (!open) return;
    setVisible(null);
    setFeedback(null);
    // A launcher already carrying an extra key opens with the section unfolded:
    // it is configured state, not an option left to discover again.
    setExpanded(extraKeyCount > 0);
  }, [open]);

  async function run(
    operation: () => Promise<OperationResult<unknown>>,
    successMessage: string,
  ): Promise<void> {
    setWorking(true);
    setFeedback(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setFeedback({ tone: "error", text: result.error ?? copy.app.operationFailed });
        return;
      }
      setFeedback({ tone: "success", text: successMessage });
    } catch {
      setFeedback({ tone: "error", text: copy.app.operationFailed });
    } finally {
      setWorking(false);
    }
  }

  function applyPlayerKey(profile: LaunchProfileId): void {
    const draft = normalizePlayerKey(drafts[profile]);
    if (!isValidPlayerKey(draft)) {
      setFeedback({ tone: "error", text: copy.identity.invalid });
      return;
    }
    void run(() => window.rotk.setPlayerKey(profile, draft), copy.identity.applied);
  }

  function keyField(profile: LaunchProfileId) {
    return (
      <KeyField
        key={profile}
        copy={copy}
        profile={profile}
        websiteHost={hosts[serverOf(profile)]}
        value={drafts[profile]}
        stored={identity.keys[profile]}
        disabled={locked || working}
        visible={visible === profile}
        onChange={(next) => {
          setDrafts((current) => ({ ...current, [profile]: next }));
          setFeedback(null);
        }}
        onToggleVisible={() => setVisible((current) => (current === profile ? null : profile))}
        onSubmit={() => applyPlayerKey(profile)}
        onCopy={() => void run(() => window.rotk.copyPlayerKey(profile), copy.identity.copied)}
        onRemove={() => void run(() => window.rotk.clearPlayerKey(profile), copy.identity.removed)}
      />
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            className="install-panel__backdrop"
            aria-label={copy.identity.close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={working ? undefined : onClose}
          />
          <motion.aside
            className="identity-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
            aria-label={copy.identity.panelLabel}
          >
            <div className="install-panel__topline" />
            <header className="identity-panel__header">
              <div>
                <span className="eyebrow">{copy.identity.eyebrow}</span>
                <h2>{copy.identity.title}</h2>
              </div>
              <button type="button" className="panel-close" aria-label={copy.identity.close} onClick={onClose}>
                <X size={19} />
              </button>
            </header>

            <p className="identity-panel__intro">{copy.identity.intro}</p>

            <div className="identity-session-note">
              <ShieldCheck size={20} />
              <span>{copy.identity.sessionOnly}</span>
            </div>

            <div className="identity-account-guide">
              <span>01</span>
              <p>{copy.identity.process(hosts.game2)}</p>
              <button type="button" onClick={() => void window.rotk.openWebsite("/login", "game2")}>
                {copy.identity.openAccount(hosts.game2)}
                <ExternalLink size={15} />
              </button>
            </div>

            {keyField(PRIMARY_PROFILE)}

            <section className="identity-extra">
              <button
                type="button"
                className="identity-extra__toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((current) => !current)}
              >
                <ChevronDown size={16} className={expanded ? "is-open" : ""} />
                <strong>{copy.identity.extraKeys}</strong>
                <em>{copy.identity.extraKeysCount(extraKeyCount, SECONDARY_PROFILES.length)}</em>
              </button>
              {expanded && (
                <div className="identity-extra__body">
                  <p>{copy.identity.extraKeysHint}</p>
                  {SERVER_IDS.map((serverId) => {
                    const profiles = SECONDARY_PROFILES.filter((profile) => serverOf(profile) === serverId);
                    if (profiles.length === 0) return null;
                    const server = snapshot.runtime.servers.find((candidate) => candidate.id === serverId);
                    return (
                      <div key={serverId} className="identity-extra__server">
                        <header>
                          <strong>{server?.label ?? serverId}</strong>
                          <button
                            type="button"
                            onClick={() => void window.rotk.openWebsite("/login", serverId)}
                          >
                            {hosts[serverId]}
                            <ExternalLink size={13} />
                          </button>
                        </header>
                        {profiles.map((profile) => keyField(profile))}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <div className={`identity-feedback ${feedback ? `is-${feedback.tone}` : ""}`} aria-live="polite">
              {feedback?.text ?? " "}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

interface KeyFieldProps {
  copy: CopyText;
  profile: LaunchProfileId;
  websiteHost: string;
  value: string;
  stored: string | null;
  disabled: boolean;
  visible: boolean;
  onChange(value: string): void;
  onToggleVisible(): void;
  onSubmit(): void;
  onCopy(): void;
  onRemove(): void;
}

function KeyField({
  copy,
  profile,
  websiteHost,
  value,
  stored,
  disabled,
  visible,
  onChange,
  onToggleVisible,
  onSubmit,
  onCopy,
  onRemove,
}: KeyFieldProps) {
  const role = roleOf(profile);
  const normalized = useMemo(() => normalizePlayerKey(value), [value]);
  const valid = isValidPlayerKey(value);
  const dirty = normalized !== (stored ?? "");
  const inputId = `player-key-${profile.replace(":", "-")}`;

  return (
    <form
      className="identity-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor={inputId}>
        {copy.identity.keyLabels[role]}
        <i className={stored === null ? "is-missing" : ""}>
          {stored === null ? copy.identity.keyMissing : copy.identity.keySet}
        </i>
      </label>
      <div className="identity-key-field">
        <KeyRound size={18} />
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          value={value}
          maxLength={PLAYER_KEY_HEX_LENGTH}
          placeholder={copy.identity.placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="identity-key-field__count">{value.length}/{PLAYER_KEY_HEX_LENGTH}</span>
        <button
          type="button"
          aria-label={visible ? copy.identity.hide : copy.identity.show}
          title={visible ? copy.identity.hide : copy.identity.show}
          onClick={onToggleVisible}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
        <button
          type="button"
          aria-label={copy.identity.copy}
          title={copy.identity.copy}
          disabled={disabled || dirty || stored === null}
          onClick={onCopy}
        >
          <Copy size={17} />
        </button>
        <button
          type="button"
          aria-label={copy.identity.remove}
          title={copy.identity.remove}
          disabled={disabled || stored === null}
          onClick={onRemove}
        >
          <Trash2 size={17} />
        </button>
      </div>
      <p className="identity-form__hint">{copy.identity.keyHints[role](websiteHost)}</p>
      <div className="identity-actions">
        <button type="submit" className="identity-actions__apply" disabled={disabled || !dirty || !valid}>
          {copy.identity.apply}
        </button>
      </div>
    </form>
  );
}
