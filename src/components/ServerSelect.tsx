import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronUp, Gauge } from "lucide-react";
import type { LauncherSnapshot } from "../../shared/contracts";
import { PLAYER_ROLES, launchProfileId, type PlayerRole, type ServerId } from "../../shared/launch-profile";
import { useI18n, type Copy } from "../i18n";

interface ServerSelectProps {
  snapshot: LauncherSnapshot;
  disabled: boolean;
  onSelect(serverId: ServerId, role: PlayerRole): void;
}

/** Renders the live population, or the unreachable marker while it is unknown. */
function Population({
  copy,
  players,
  capacity,
}: {
  copy: Copy;
  players: number | null;
  capacity: number | null;
}) {
  if (players === null) {
    return (
      <span className="server-population is-unknown" title={copy.footer.playersUnknown}>
        <em />
        {copy.footer.playersUnavailable}
      </span>
    );
  }
  return (
    <span className={`server-population ${players > 0 ? "is-live" : ""}`}>
      <em />
      {capacity === null ? `${players}` : `${players}/${capacity}`}
      <small>{copy.footer.playersInGame}</small>
    </span>
  );
}

/**
 * The launch target, picked from the footer: which ROTK server, and whether the
 * launch runs as the player or the administrator. Both belong to one choice —
 * each pair authenticates with its own key — so they are one menu, not two.
 */
export function ServerSelect({ snapshot, disabled, onSelect }: ServerSelectProps) {
  const { copy } = useI18n();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const identity = snapshot.playerIdentity;
  const adminMode = identity.role === "admin";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Handled: the page under the menu stays open.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // A launch or an installation freezes the selection in the main process; the
  // menu must not stay open offering choices it can no longer apply.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="launcher-footer__server" ref={container}>
      <AnimatePresence>
        {open && (
          <motion.div
            className="server-select__menu"
            role="listbox"
            aria-label={copy.footer.selectServer}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            {snapshot.runtime.servers.map((server) => (
              <div key={server.id} className="server-select__group">
                <header>
                  <strong>{server.label}</strong>
                  <Population copy={copy} players={server.players} capacity={server.capacity} />
                  <i className={server.environment === "development" ? "is-dev" : ""}>
                    {server.environment === "development" ? "DEV" : "LIVE"}
                  </i>
                </header>
                {PLAYER_ROLES.map((role) => {
                  const selected = server.id === identity.serverId && role === identity.role;
                  const hasKey = identity.keys[launchProfileId(server.id, role)] !== null;
                  return (
                    <button
                      key={role}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={selected ? "is-selected" : ""}
                      onClick={() => {
                        setOpen(false);
                        if (!selected) onSelect(server.id, role);
                      }}
                    >
                      <Check size={14} className={selected ? "" : "is-hidden"} />
                      <span>{copy.identity.roles[role]}</span>
                      <em className={hasKey ? "" : "is-missing"}>
                        {hasKey ? copy.identity.keySet : copy.identity.keyMissing}
                      </em>
                    </button>
                  );
                })}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        className="server-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={copy.footer.selectServer}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Gauge size={18} />
        <div>
          <span>{copy.footer.environment}</span>
          <strong>{snapshot.runtime.label}</strong>
        </div>
        <Population
          copy={copy}
          players={snapshot.runtime.players}
          capacity={snapshot.runtime.capacity}
        />
        {adminMode && <i className="is-admin">{copy.footer.adminMode}</i>}
        <i className={snapshot.runtime.environment === "development" ? "is-dev" : ""}>
          {snapshot.runtime.environment === "development" ? "DEV" : "LIVE"}
        </i>
        <ChevronUp size={16} className={`server-select__caret ${open ? "is-open" : ""}`} />
      </button>
    </div>
  );
}
