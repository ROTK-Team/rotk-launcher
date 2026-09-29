export const APP_LOCALES = ["en", "fr", "zh"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (APP_LOCALES as readonly string[]).includes(value);
}

export function normalizeAppLocale(value: unknown): AppLocale {
  return isAppLocale(value) ? value : "en";
}
