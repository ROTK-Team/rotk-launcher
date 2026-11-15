import { AppWindow, Check, Gamepad2 } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { PlayerFontSummary } from "../../shared/contracts";
import { useI18n } from "../i18n";
import { loadPlayerFont, type PreviewFamilies } from "../player-font-faces";

interface FontPickerProps {
  playerFont: PlayerFontSummary;
  busy: boolean;
  onSelect(id: string): void;
  onSelectLauncher(id: string): void;
}

/** The launcher first: it is where the player is, and its font changes at once. */
const TARGETS = ["launcher", "game"] as const;
type Target = (typeof TARGETS)[number];

/** The launcher's own faces: its "original" is Eurostile and Inter, not the game's stock files. */
const OWN = { display: '"Eurostile", "Arial", sans-serif', text: '"Inter", sans-serif' };
/** Chinese has no glyph in these fonts: it falls back as it does in the rest of the launcher. */
const family = (name: string) => `"${name}", "Microsoft YaHei", "PingFang SC", sans-serif`;

/**
 * The faces of a choice, once loaded. On a change it keeps the previous ones
 * until the next are ready: blanking the preview on every hover made it blink.
 */
function useFamilies(id: string): PreviewFamilies | null {
  const [families, setFamilies] = useState<PreviewFamilies | null>(null);
  useEffect(() => {
    let current = true;
    loadPlayerFont(id).then((names) => current && setFamilies(names)).catch(() => undefined);
    return () => { current = false; };
  }, [id]);
  return families;
}

/**
 * A font's name written in that font: the face of the game's titles, or the one
 * the launcher draws its own titles with.
 * ponytail: every font of the list is loaded when the tab opens (13 fonts, read
 * once); load on scroll if the list ever grows long.
 */
function Specimen({ id, target, children }: { id: string; target: Target; children: ReactNode }) {
  const families = useFamilies(id);
  const fontFamily = id === "original" && target === "launcher" ? OWN.display : families ? family(target === "game" ? families.title : families.launcherDisplay) : undefined;
  return <span className="look__specimen" style={{ fontFamily }}>{children}</span>;
}

/** The Appearance tab: the launcher's own font, and the font of the game's interface. */
export function FontPicker({ playerFont, busy, onSelect, onSelectLauncher }: FontPickerProps) {
  const { copy } = useI18n();
  const t = copy.fonts;
  const [target, setTarget] = useState<Target>("launcher");
  const chosen = { game: playerFont.selected, launcher: playerFont.launcherSelected };
  const labels = { game: t.targetGame, launcher: t.targetLauncher };
  const selected = chosen[target];
  const [shown, setShown] = useState(selected);
  const families = useFamilies(shown);

  // Back to the target's own choice on a switch, a new choice, or a busy page
  // (a disabled button gets no mouseleave).
  useEffect(() => setShown(selected), [selected, busy, target]);

  if (playerFont.options.length === 0) return null;
  const name = (id: string) => (id === "original" ? t.original : playerFont.options.find((font) => font.id === id)?.name ?? id);
  const option = playerFont.options.find((font) => font.id === shown);
  // Hover previews only inside the stage: redrawing the whole launcher on hover
  // reflowed this very list under the cursor. A click applies it to the launcher (App).
  const face = (role: keyof PreviewFamilies): CSSProperties => (families ? { fontFamily: family(families[role]) } : { visibility: "hidden" });
  const own = (display: boolean): CSSProperties => (shown === "original"
    ? { fontFamily: display ? OWN.display : OWN.text }
    : face(display ? "launcherDisplay" : "launcherText"));
  const choose = target === "game" ? onSelect : onSelectLauncher;

  const [squad, mode, ...carried] = t.sampleText.split(" · ");
  const buttons = t.sampleButtons.split(" · ");
  const [play, news, server] = t.sampleLauncherNav.split(" · ");

  return (
    <div className="look">
      <div className="look__choose">
        {/* What is being dressed, each with the font it wears today. */}
        <div className="look__targets" role="radiogroup" aria-label={copy.settings.tabs.look}>
          {TARGETS.map((id) => {
            const Icon = id === "game" ? Gamepad2 : AppWindow;
            return (
              <button key={id} type="button" role="radio" aria-checked={target === id} onClick={() => setTarget(id)}>
                <Icon size={20} aria-hidden="true" />
                <span className="look__target">
                  <small>{labels[id]}</small>
                  <Specimen id={chosen[id]} target={id}>{name(chosen[id])}</Specimen>
                </span>
              </button>
            );
          })}
        </div>
        {/* Leaving the whole list, not one row, restores the choice: the lines between
            rows no longer flip the stage back and forth. */}
        <div
          className="look__fonts"
          role="listbox"
          aria-label={labels[target]}
          onMouseLeave={() => setShown(selected)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShown(selected);
          }}
        >
          {playerFont.options.map((font) => (
            <button
              key={font.id}
              type="button"
              role="option"
              aria-selected={font.id === selected}
              data-shown={font.id === shown}
              disabled={busy}
              onMouseEnter={() => setShown(font.id)}
              onFocus={() => setShown(font.id)}
              onClick={() => choose(font.id)}
            >
              <Specimen id={font.id} target={target}>{name(font.id)}</Specimen>
              {font.id === selected && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <p className="look__hint">{target === "game" ? t.description : t.launcherDescription}</p>
      </div>

      <div className="look__see">
        {/* A small screen of what the font dresses. The sample text never changes, only
            its letters: a screen reader is told the font's name below instead. */}
        {target === "game" ? (
          <div className="look__stage look__stage--game" aria-hidden="true">
            <span className="look__hud look__hud--tl" style={face("body")}>{squad}</span>
            <span className="look__hud look__hud--tr" style={face("body")}>{t.sampleFeed}</span>
            <div className="look__center">
              <small style={face("button")}>{mode}</small>
              <strong style={face("title")}>{t.sampleTitle}</strong>
              <div className="look__chips" style={face("button")}>
                {buttons.map((button) => <span key={button}>{button}</span>)}
              </div>
            </div>
            <span className="look__hud look__hud--bl" style={face("body")}>{carried.join(" · ")}</span>
            <span className="look__hud look__hud--br" style={face("body")}>0123456789 · 124 m · 100 %</span>
          </div>
        ) : (
          <div className="look__stage look__stage--launcher" aria-hidden="true">
            <div className="look__bar">
              <strong style={own(true)}>ROTK LAUNCHER</strong>
              <span style={own(true)}>{news}</span>
            </div>
            <div className="look__page">
              <strong style={own(true)}>{name(shown)}</strong>
              <p style={own(false)}>{t.sampleLauncherText}</p>
            </div>
            <div className="look__foot">
              <span style={own(false)}>{server}</span>
              <b style={own(true)}>{play}</b>
            </div>
          </div>
        )}
        {/* Lines of fixed height, the warning's included: nothing moves while the mouse is on the list. */}
        <div className="look__caption">
          <strong aria-live="polite"><Specimen id={shown} target={target}>{name(shown)}</Specimen></strong>
          {shown === selected && <span className="look__current"><Check size={13} aria-hidden="true" />{labels[target]}</span>}
          <p>{target === "game" ? t.nextLaunch : t.launcherNow}</p>
          <p className="look__warning">{target === "game" && option && !option.cyrillic ? t.noCyrillic : " "}</p>
        </div>
      </div>
    </div>
  );
}
