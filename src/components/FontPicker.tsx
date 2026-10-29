import { Type } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlayerFontSummary } from "../../shared/contracts";
import { useI18n } from "../i18n";
import { loadPlayerFont, type PreviewFamilies } from "../player-font-faces";

interface FontPickerProps {
  playerFont: PlayerFontSummary;
  busy: boolean;
  onSelect(id: string): void;
  onSelectLauncher(id: string): void;
}

type Target = "game" | "launcher";

export function FontPicker({ playerFont, busy, onSelect, onSelectLauncher }: FontPickerProps) {
  const { copy } = useI18n();
  const [target, setTarget] = useState<Target>("game");
  const selected = target === "game" ? playerFont.selected : playerFont.launcherSelected;
  const [shown, setShown] = useState(selected);
  // The preview keeps the last loaded font until the next one is ready: blanking it
  // on every hover made the frame blink.
  const [families, setFamilies] = useState<PreviewFamilies | null>(null);
  const option = playerFont.options.find((font) => font.id === shown);

  // Back to the tab's own choice on a tab switch, a new choice, or a busy panel
  // (a disabled button gets no mouseleave).
  useEffect(() => setShown(selected), [selected, busy, target]);
  useEffect(() => {
    let current = true;
    loadPlayerFont(shown).then((names) => current && setFamilies(names)).catch(() => undefined);
    return () => { current = false; };
  }, [shown]);

  if (playerFont.options.length === 0) return null;
  // Hover previews only inside the frame: redrawing the whole launcher on hover
  // reflowed this very list under the cursor. A click applies it to the launcher (App).
  const style = (role: keyof PreviewFamilies) => (families ? { fontFamily: `"${families[role]}"` } : { visibility: "hidden" as const });
  // "Original" for the launcher is its own Eurostile/Inter, not the game's stock files.
  const launcherStyle = (display: boolean) => (shown === "original"
    ? { fontFamily: display ? '"Eurostile", "Arial", sans-serif' : '"Inter", sans-serif' }
    : style(display ? "launcherDisplay" : "launcherText"));
  const choose = target === "game" ? onSelect : onSelectLauncher;
  const name = (id: string, fallback: string) => (id === "original" ? copy.fonts.original : fallback);

  return (
    <section className="font-section" aria-label={copy.fonts.title}>
      <div className="asset-section__heading">
        <span><Type size={16} /> {copy.fonts.title}</span>
      </div>
      <div className="font-section__targets" role="tablist">
        {(["game", "launcher"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={target === value}
            data-selected={target === value}
            onClick={() => setTarget(value)}
          >
            {value === "game" ? copy.fonts.targetGame : copy.fonts.targetLauncher}
          </button>
        ))}
      </div>
      <p className="asset-section__description">{target === "game" ? copy.fonts.description : copy.fonts.launcherDescription}</p>
      {/* Leaving the whole grid, not one button, restores the choice: the gaps between
          buttons no longer flip the preview back and forth. */}
      <div
        className="font-section__list"
        role="listbox"
        aria-label={copy.fonts.title}
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
            className="font-section__option"
            data-selected={font.id === selected}
            data-shown={font.id === shown}
            disabled={busy}
            onMouseEnter={() => setShown(font.id)}
            onFocus={() => setShown(font.id)}
            onClick={() => choose(font.id)}
          >
            {name(font.id, font.name)}
          </button>
        ))}
      </div>
      {/* One frame of fixed size for both tabs, and a reserved line for the warning:
          nothing below the grid may move while the mouse is on it. */}
      {target === "launcher" ? (
        <div className="font-section__preview font-section__preview--launcher" aria-live="polite">
          <strong style={launcherStyle(true)}>ROTK LAUNCHER</strong>
          <span className="font-section__buttons" style={launcherStyle(true)}>{copy.fonts.sampleLauncherNav}</span>
          <p style={launcherStyle(false)}>{copy.fonts.sampleLauncherText}</p>
        </div>
      ) : (
        <div className="font-section__preview" aria-live="polite">
          <strong style={style("title")}>{copy.fonts.sampleTitle}</strong>
          <span className="font-section__buttons" style={style("button")}>{copy.fonts.sampleButtons}</span>
          <p style={style("body")}>{copy.fonts.sampleFeed}</p>
          <p style={style("body")}>{copy.fonts.sampleText}</p>
          <p style={style("body")}>0123456789 · 4/5 · 124 m · 100 %</p>
        </div>
      )}
      <small className="asset-section__warning font-section__warning">
        {target === "game" && option && !option.cyrillic ? copy.fonts.noCyrillic : " "}
      </small>
      <small className="asset-section__version">{target === "game" ? copy.fonts.nextLaunch : copy.fonts.launcherNow}</small>
    </section>
  );
}
