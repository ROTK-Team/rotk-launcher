import { Minus, Settings2, X } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { useI18n } from "../i18n";

interface WindowChromeProps {
  /**
   * False while the launcher is still starting: only the drag region and the
   * minimize and close buttons are shown, the two controls the main process
   * answers before its services are ready.
   */
  ready: boolean;
  /** The page shown under the bar, and how to change it. */
  page?: "home" | "settings";
  onPage?(page: "home" | "settings"): void;
  /** A copy is running: the assistant cannot be left, the pages do not answer. */
  locked?: boolean;
}

export function WindowChrome({ ready, page, onPage, locked = false }: WindowChromeProps) {
  const { copy } = useI18n();
  return (
    <header className="window-chrome">
      <div className="window-chrome__drag">
        <BrandMark />
        <div className="window-chrome__division" />
        {ready && onPage && (
          <nav className="window-chrome__nav">
            {(["home", "settings"] as const).map((id) => (
              <button key={id} type="button" aria-current={page === id ? "page" : undefined} disabled={locked} onClick={() => onPage(id)}>
                {id === "settings" && <Settings2 size={15} aria-hidden="true" />}{copy.chrome[id]}
              </button>
            ))}
          </nav>
        )}
      </div>
      <div className="window-chrome__tools">
        <button type="button" className="window-button" aria-label={copy.chrome.minimize} onClick={() => void window.rotk.minimizeWindow()}>
          <Minus size={17} />
        </button>
        <button type="button" className="window-button window-button--close" aria-label={copy.chrome.close} onClick={() => void window.rotk.closeWindow()}>
          <X size={17} />
        </button>
      </div>
    </header>
  );
}
