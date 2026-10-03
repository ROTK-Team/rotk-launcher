import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, ExternalLink, Minus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppLocale } from "../../shared/locale";
import { BrandMark } from "./BrandMark";
import { useI18n } from "../i18n";

interface WindowChromeProps {
  appVersion: string;
}

const LANGUAGE_OPTIONS: Array<{ locale: AppLocale }> = [
  { locale: "en" },
  { locale: "fr" },
  { locale: "zh" },
];

function languageName(locale: AppLocale, copy: ReturnType<typeof useI18n>["copy"]): string {
  return locale === "fr" ? copy.language.french : locale === "zh" ? copy.language.chinese : copy.language.english;
}

function FlagIcon({ locale }: { locale: AppLocale }) {
  if (locale === "zh") {
    return (
      <svg className="language-picker__flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect width="24" height="16" fill="#de2910" />
        <path d="M5 2.2 5.9 4.9H8.7L6.4 6.5 7.3 9.2 5 7.6 2.7 9.2 3.6 6.5 1.3 4.9H4.1Z" fill="#ffde00" />
      </svg>
    );
  }
  if (locale === "fr") {
    return (
      <svg className="language-picker__flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect width="8" height="16" fill="#1c3f92" />
        <rect x="8" width="8" height="16" fill="#fff" />
        <rect x="16" width="8" height="16" fill="#e33a3a" />
      </svg>
    );
  }
  return (
    <svg className="language-picker__flag" viewBox="0 0 24 16" aria-hidden="true">
      <rect width="24" height="16" fill="#17365f" />
      <path d="M0 0 24 16M24 0 0 16" stroke="#fff" strokeWidth="4" />
      <path d="M0 0 24 16M24 0 0 16" stroke="#c8323a" strokeWidth="1.8" />
      <path d="M12 0v16M0 8h24" stroke="#fff" strokeWidth="5" />
      <path d="M12 0v16M0 8h24" stroke="#c8323a" strokeWidth="2.6" />
    </svg>
  );
}

export function LanguagePicker({ placement = "chrome" }: { placement?: "chrome" | "panel" }) {
  const { locale, setLocale, copy } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const current = LANGUAGE_OPTIONS.find((option) => option.locale === locale)!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className={`language-picker language-picker--${placement}`}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="language-picker__trigger"
        aria-label={copy.language.change(languageName(locale, copy))}
        aria-expanded={open}
        aria-controls={`language-options-${placement}`}
        onClick={() => setOpen((value) => !value)}
      >
        <FlagIcon locale={current.locale} />
        <span>{locale.toLocaleUpperCase("en-US")}</span>
        <ChevronDown size={13} className={open ? "is-open" : ""} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="language-picker__menu"
            id={`language-options-${placement}`}
            role="group"
            aria-label={copy.language.label}
            initial={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            {LANGUAGE_OPTIONS.map((option) => {
              const active = option.locale === locale;
              const label = languageName(option.locale, copy);
              return (
                <button
                  key={option.locale}
                  type="button"
                  aria-pressed={active}
                  className={active ? "is-active" : ""}
                  onClick={() => {
                    setLocale(option.locale);
                    setOpen(false);
                  }}
                >
                  <FlagIcon locale={option.locale} />
                  <span>{label}</span>
                  <small>{option.locale.toLocaleUpperCase("en-US")}</small>
                  {active && <Check size={14} />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function WindowChrome({ appVersion }: WindowChromeProps) {
  const { copy } = useI18n();
  return (
    <header className="window-chrome">
      <div className="window-chrome__drag">
        <BrandMark />
        <div className="window-chrome__division" />
        <span className="window-chrome__section">{copy.chrome.launcher}</span>
      </div>
      <div className="window-chrome__tools">
        <button
          type="button"
          className="chrome-link"
          onClick={() => void window.rotk.openWebsite("/updates")}
        >
          {copy.chrome.updates} <ExternalLink size={13} strokeWidth={1.8} />
        </button>
        <LanguagePicker />
        <span className="chrome-version">{copy.chrome.build} {appVersion}</span>
        <button
          type="button"
          className="window-button"
          aria-label={copy.chrome.minimize}
          onClick={() => void window.rotk.minimizeWindow()}
        >
          <Minus size={17} />
        </button>
        <button
          type="button"
          className="window-button window-button--close"
          aria-label={copy.chrome.close}
          onClick={() => void window.rotk.closeWindow()}
        >
          <X size={17} />
        </button>
      </div>
    </header>
  );
}
