import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
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
import { Group } from "./SettingsControls";

interface AccountKeysProps {
  snapshot: LauncherSnapshot;
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

/** The launcher keys of every server and role: the Account tab of the settings. */
export function AccountKeys({ snapshot }: AccountKeysProps) {
  const { copy } = useI18n();
  const identity = snapshot.playerIdentity;
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(identity));
  const [visible, setVisible] = useState<LaunchProfileId | null>(null);
  // A launcher already carrying an extra key opens with the section unfolded:
  // it is configured state, not an option left to discover again.
  const [expanded, setExpanded] = useState(() => SECONDARY_PROFILES.some((profile) => snapshot.playerIdentity.keys[profile] !== null));
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

  const label = (serverId: ServerId) => snapshot.runtime.servers.find((server) => server.id === serverId)?.label ?? serverId;

  return (
    <div className="account-keys">
      <p className="account-keys__note"><ShieldCheck size={16} aria-hidden="true" /> {copy.identity.sessionOnly}</p>

      <Group title={label(serverOf(PRIMARY_PROFILE))}>{keyField(PRIMARY_PROFILE)}</Group>

      {/* Every server has its own accounts, and an administrator key is another account. */}
      <details className="settings-advanced" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{copy.identity.extraKeys} · {copy.identity.extraKeysCount(extraKeyCount, SECONDARY_PROFILES.length)}</summary>
        <p className="settings-advanced__lead">{copy.identity.extraKeysHint}</p>
        {SERVER_IDS.map((serverId) => {
          const profiles = SECONDARY_PROFILES.filter((profile) => serverOf(profile) === serverId);
          return profiles.length === 0 ? null : <Group key={serverId} title={label(serverId)}>{profiles.map((profile) => keyField(profile))}</Group>;
        })}
      </details>

      <p className={`settings-feedback${feedback ? ` is-${feedback.tone}` : ""}`} aria-live="polite">{feedback?.text}</p>
    </div>
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

function KeyField({ copy, profile, websiteHost, value, stored, disabled, visible, onChange, onToggleVisible, onSubmit, onCopy, onRemove }: KeyFieldProps) {
  const role = roleOf(profile);
  const normalized = useMemo(() => normalizePlayerKey(value), [value]);
  const valid = isValidPlayerKey(value);
  const dirty = normalized !== (stored ?? "");
  const inputId = `player-key-${profile.replace(":", "-")}`;

  return (
    <form className="key-row" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="key-row__head">
        <label htmlFor={inputId}>{copy.identity.keyLabels[role]}</label>
        <span className="settings-status" data-status={stored === null ? "error" : "up-to-date"}>
          {stored === null ? copy.identity.keyMissing : copy.identity.keySet}
        </span>
      </div>
      <div className="key-field">
        <KeyRound size={18} aria-hidden="true" />
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
        <button type="button" className="key-field__tool" aria-label={visible ? copy.identity.hide : copy.identity.show} title={visible ? copy.identity.hide : copy.identity.show} onClick={onToggleVisible}>
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
        <button type="button" className="key-field__tool" aria-label={copy.identity.copy} title={copy.identity.copy} disabled={disabled || dirty || stored === null} onClick={onCopy}>
          <Copy size={17} />
        </button>
        <button type="button" className="key-field__tool" aria-label={copy.identity.remove} title={copy.identity.remove} disabled={disabled || stored === null} onClick={onRemove}>
          <Trash2 size={17} />
        </button>
        <button type="submit" className="launcher-button" disabled={disabled || !dirty || !valid}>{copy.install.saveKey}</button>
      </div>
      <p className="key-row__hint">
        {copy.identity.keyHints[role](websiteHost)}{" "}
        <button type="button" className="launcher-link" onClick={() => void window.rotk.openWebsite("/login", serverOf(profile))}>
          {copy.identity.openAccount(websiteHost)}
        </button>
      </p>
    </form>
  );
}
