import type { AppLocale } from "../../shared/locale";

/** The flag a language is recognized by, whatever language the launcher is in. */
export function LanguageFlag({ locale }: { locale: AppLocale }) {
  if (locale === "zh") {
    return (
      <svg className="language-flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect width="24" height="16" fill="#de2910" />
        <path d="M5 2.2 5.9 4.9H8.7L6.4 6.5 7.3 9.2 5 7.6 2.7 9.2 3.6 6.5 1.3 4.9H4.1Z" fill="#ffde00" />
      </svg>
    );
  }
  if (locale === "fr") {
    return (
      <svg className="language-flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect width="8" height="16" fill="#1c3f92" />
        <rect x="8" width="8" height="16" fill="#fff" />
        <rect x="16" width="8" height="16" fill="#e33a3a" />
      </svg>
    );
  }
  return (
    <svg className="language-flag" viewBox="0 0 24 16" aria-hidden="true">
      <rect width="24" height="16" fill="#17365f" />
      <path d="M0 0 24 16M24 0 0 16" stroke="#fff" strokeWidth="4" />
      <path d="M0 0 24 16M24 0 0 16" stroke="#c8323a" strokeWidth="1.8" />
      <path d="M12 0v16M0 8h24" stroke="#fff" strokeWidth="5" />
      <path d="M12 0v16M0 8h24" stroke="#c8323a" strokeWidth="2.6" />
    </svg>
  );
}
