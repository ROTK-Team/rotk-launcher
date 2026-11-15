import type { BannerMessage, FeaturedCard, HomeBackgrounds, LauncherBanner, LauncherEvent } from "../../shared/contracts.js";
import { APP_LOCALES, type AppLocale } from "../../shared/locale.js";
import { WEBSITE_ORIGIN } from "../constants.js";

const EVENTS_FEED_URL = `${WEBSITE_ORIGIN}/api/competitions`;
const BANNER_FEED_URL = `${WEBSITE_ORIGIN}/api/launcher/banner`;
const MAX_FEED_BYTES = 1_000_000;
const MAX_EVENTS = 5;
const MAX_MESSAGE_LENGTH = 200;
const MAX_MESSAGES = 5;
const MAX_FEATURED = 3;
const MAX_BACKGROUNDS = 8;
/** What a player can still join or watch. Drafts, finished and cancelled competitions are not events. */
const LIVE_PHASES = ["running", "applications", "roster"] as const;
const BANNER_MODES = ["auto", "message", "news", "event", "off"] as const;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readDate(value: unknown): string | null {
  const text = readString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

/**
 * The competitions of the site's public list that are open or running, the
 * running ones first. Each entry is read field by field: one the launcher
 * cannot use is left out, the others stay. The link is built here, from the
 * site's own key, so the window never opens a path it was handed.
 */
export function parseEvents(value: unknown): LauncherEvent[] {
  const seasons = value && typeof value === "object" ? (value as { seasons?: unknown }).seasons : null;
  if (!Array.isArray(seasons)) throw new Error("Unexpected events feed response");
  const events: LauncherEvent[] = [];
  for (const season of seasons as Array<Record<string, unknown> | null>) {
    if (!season || typeof season !== "object") continue;
    const phase = LIVE_PHASES.find((candidate) => candidate === season.phase);
    const key = readString(season.key);
    const name = readString(season.name);
    if (!phase || !key || !name || season.listed !== true || season.suspendedAt) continue;
    events.push({
      id: key,
      name: name.slice(0, 120),
      host: readString(season.creatorName).slice(0, 48),
      mode: readString(season.mode).slice(0, 16),
      region: readString(season.region).slice(0, 8),
      phase,
      startsAt: readDate(season.startsAt),
      applicationsCloseAt: readDate(season.applicationsCloseAt),
      sitePath: `/${season.type === "league" ? "league" : "tournaments"}?season=${encodeURIComponent(key)}`,
    });
  }
  return events
    .sort((left, right) => LIVE_PHASES.indexOf(left.phase) - LIVE_PHASES.indexOf(right.phase))
    .slice(0, MAX_EVENTS);
}

/**
 * What the site's staff chose for the line of the home page. A message is
 * plain text the window shows as it is; a link is only kept when it is a path
 * of the ROTK site, never an address of its own. The site gives its messages
 * as a list, and the first one on its own too: the list is read when it is there.
 */
export function parseBanner(value: unknown): LauncherBanner {
  const banner = value && typeof value === "object" ? (value as { banner?: unknown }).banner : null;
  if (!banner || typeof banner !== "object") throw new Error("Unexpected banner response");
  const fields = banner as Record<string, unknown>;
  // A mode this build does not know (a newer site) is read as no choice at all.
  const mode = BANNER_MODES.find((candidate) => candidate === fields.mode) ?? "auto";
  const readMessage = (entry: unknown): BannerMessage => {
    const message = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return { text: readTexts(message.message, MAX_MESSAGE_LENGTH, true), link: readSitePath(message.link) };
  };
  return {
    // Only an explicit "off" turns the line off: a site that does not say is on.
    enabled: fields.enabled !== false,
    mode,
    messages: (Array.isArray(fields.messages) && fields.messages.length > 0 ? fields.messages : [fields]).slice(0, MAX_MESSAGES).map(readMessage).filter((message) => message.text.en),
    eventKey: readString(fields.eventKey).slice(0, 120) || null,
  };
}

/**
 * The cards the staff put before the publications. One that has no title is
 * left out; the others stay. The site only gives the cards that are on, decided
 * with its own clock: this PC's clock, which can be wrong, is not asked again.
 */
export function parseFeatured(value: unknown): FeaturedCard[] {
  const cards = value && typeof value === "object" ? (value as { featured?: unknown }).featured : null;
  if (!Array.isArray(cards)) return [];
  const featured: FeaturedCard[] = [];
  for (const card of cards as Array<Record<string, unknown> | null>) {
    if (!card || typeof card !== "object") continue;
    const id = readString(card.id).slice(0, 80);
    const title = readTexts(card.title, 80, true);
    if (!id || !title.en) continue;
    const siteImage = (value: unknown) => {
      const path = readSitePath(value);
      return path ? new URL(path, WEBSITE_ORIGIN).href : "";
    };
    featured.push({
      id,
      label: readTexts(card.label, 24, true),
      title,
      summary: readTexts(card.summary, 400, false),
      imageUrl: siteImage(card.image),
      backgroundUrl: siteImage(card.background),
      link: readSitePath(card.link),
      endsAt: readDate(card.endsAt),
    });
  }
  return featured.slice(0, MAX_FEATURED);
}

/**
 * The images for the back of the home page: only paths of the ROTK site, shown
 * one after the other when the staff asked for a rotation of several.
 */
export function parseBackgrounds(value: unknown): HomeBackgrounds {
  const backgrounds = value && typeof value === "object" ? (value as { backgrounds?: unknown }).backgrounds : null;
  const fields = backgrounds && typeof backgrounds === "object" ? backgrounds as Record<string, unknown> : {};
  const images = (Array.isArray(fields.images) ? fields.images : [])
    .map(readSitePath)
    .filter((path): path is string => path !== null)
    .slice(0, MAX_BACKGROUNDS)
    .map((path) => new URL(path, WEBSITE_ORIGIN).href);
  const seconds = typeof fields.seconds === "number" && Number.isFinite(fields.seconds) ? fields.seconds : 12;
  return {
    images,
    rotateSeconds: fields.mode === "rotate" && images.length > 1 ? Math.min(120, Math.max(5, Math.round(seconds))) : null,
  };
}

/** A text by language. On one line, line breaks become spaces; a summary keeps them (they make its list). */
function readTexts(value: unknown, maxLength: number, singleLine: boolean): Record<AppLocale, string> {
  const texts = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(APP_LOCALES.map((locale) => {
    const text = readString(texts[locale]);
    return [locale, (singleLine ? text.replace(/\s+/g, " ") : text).slice(0, maxLength)];
  })) as Record<AppLocale, string>;
}

/**
 * A path of the ROTK site, never an address of its own. What decides is where
 * the path leads once resolved, as a browser would: a tab or a line break
 * inside it is dropped by the resolution, and "/<tab>/host" is another site.
 */
function readSitePath(value: unknown): string | null {
  const path = readString(value);
  if (!path.startsWith("/") || path.includes("\\")) return null;
  try {
    const url = new URL(path, WEBSITE_ORIGIN);
    return url.origin === WEBSITE_ORIGIN ? `${url.pathname}${url.search}${url.hash}`.slice(0, 200) : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const responseUrl = new URL(response.url || url);
    if (responseUrl.protocol !== "https:" || responseUrl.origin !== WEBSITE_ORIGIN) throw new Error("Redirected outside rotk.app");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_FEED_BYTES) throw new Error("Answer too large");
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

/** Reads the events to show on the home page. Throws when the site cannot be read: the caller keeps what it had. */
export async function fetchEvents(fetchImpl: typeof fetch = fetch): Promise<LauncherEvent[]> {
  return parseEvents(await fetchJson(EVENTS_FEED_URL, fetchImpl));
}

/**
 * Reads what the staff chose for the home page: its line, its cards and its
 * images, each on its own, so one the launcher cannot read does not cost the
 * others (no line: the home page decides its own). Throws when the site cannot be read.
 */
export async function fetchHomeChoice(fetchImpl: typeof fetch = fetch): Promise<{ banner: LauncherBanner | null; featured: FeaturedCard[]; backgrounds: HomeBackgrounds }> {
  const answer = await fetchJson(BANNER_FEED_URL, fetchImpl);
  let banner: LauncherBanner | null = null;
  try {
    banner = parseBanner(answer);
  } catch {
    // The cards and the images are still read.
  }
  return { banner, featured: parseFeatured(answer), backgrounds: parseBackgrounds(answer) };
}
