import { useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, MoveUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { LauncherBanner, LauncherEvent, PublishedUpdate } from "../../shared/contracts";
import { useI18n } from "../i18n";

interface HomeBannerProps {
  /** What the site's staff chose to show; null when the site has no choice to give. */
  banner: LauncherBanner | null;
  events: LauncherEvent[];
  updates: PublishedUpdate[];
}

interface Line {
  key: string;
  status: string;
  live: boolean;
  title: string;
  details: string;
  /** Path on the ROTK site, when the line leads somewhere. */
  path: string | null;
}

/**
 * The line under the title bar of the home page. The site's staff decides
 * what it says: messages of their own, the latest publication, or the
 * competitions that are running or taking sign-ups. Without a choice (or with
 * nothing to show for it), the competitions are shown, and nothing at all
 * when there is none.
 */
export function HomeBanner({ banner, events, updates }: HomeBannerProps) {
  const { copy, locale } = useI18n();
  const t = copy.events;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = useReducedMotion();

  const eventLine = (event: LauncherEvent): Line => {
    // The site keeps "applications" until its staff moves on: sign-ups are only announced while they are open.
    const closesAt = event.applicationsCloseAt ? Date.parse(event.applicationsCloseAt) : null;
    const open = event.phase === "applications" && (closesAt === null || closesAt > Date.now());
    const until = open && closesAt !== null
      ? t.until(new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : locale === "zh" ? "zh-CN" : "en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(closesAt))
      : null;
    return {
      key: event.id,
      status: event.phase === "running" ? t.running : open ? t.applications : t.soon,
      live: event.phase === "running",
      title: event.name,
      details: [event.host, event.mode.toLocaleUpperCase("en-US"), event.region.toLocaleUpperCase("en-US"), until].filter(Boolean).join(" · "),
      path: event.sitePath,
    };
  };

  const mode = banner?.enabled === false ? "off" : banner?.mode ?? "auto";
  const messages = mode === "message"
    ? (banner?.messages ?? []).map((message) => ({ text: message.text[locale] || message.text.en, link: message.link })).filter((message) => message.text)
    : [];
  const latest = updates[0];
  const chosenEvents = banner?.eventKey && events.some((event) => event.id === banner.eventKey)
    ? events.filter((event) => event.id === banner.eventKey)
    : events;
  const lines: Line[] = mode === "off" ? []
    : messages.length > 0
      ? messages.map((message, at) => ({ key: `message:${at}`, status: t.message, live: false, title: message.text, details: "", path: message.link }))
      : mode === "news" && latest
        ? [{
          key: latest.id,
          status: latest.type === "patch" ? copy.news.patchNote : copy.news.devUpdate,
          live: false,
          title: latest.title,
          details: latest.version ? `${copy.news.version} ${latest.version}` : "",
          path: `/updates/${encodeURIComponent(latest.id)}?lang=${locale}`,
        }]
        : chosenEvents.map(eventLine);

  useEffect(() => {
    if (lines.length < 2 || paused || reduceMotion) return;
    const timer = window.setInterval(() => setIndex((current) => current + 1), 8_000);
    return () => window.clearInterval(timer);
  }, [lines.length, paused, reduceMotion]);

  if (lines.length === 0) return null;
  const at = ((index % lines.length) + lines.length) % lines.length;
  const line = lines[at];
  const body = (
    <>
      <strong>{line.title}</strong>
      {line.details && <small>{line.details}</small>}
      {line.path && <span>{t.view} <MoveUpRight size={14} aria-hidden="true" /></span>}
    </>
  );

  return (
    <aside
      className="home-banner"
      data-kind={messages.length > 0 ? "message" : undefined}
      aria-label={t.label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <span className="home-banner__status" data-live={line.live}><i aria-hidden="true" />{line.status}</span>
      {line.path
        ? <button type="button" className="home-banner__line" onClick={() => void window.rotk.openWebsite(line.path as string)}>{body}</button>
        : <div className="home-banner__line">{body}</div>}
      {lines.length > 1 && (
        <>
          <span className="home-banner__count" aria-hidden="true">{at + 1} / {lines.length}</span>
          {/* Two boxes of the width of the window buttons above them: their lines carry on. */}
          <div className="home-banner__nav">
            <button type="button" aria-label={t.previous} onClick={() => setIndex(at - 1)}><ChevronLeft size={16} /></button>
            <button type="button" aria-label={t.next} onClick={() => setIndex(at + 1)}><ChevronRight size={16} /></button>
          </div>
        </>
      )}
    </aside>
  );
}
