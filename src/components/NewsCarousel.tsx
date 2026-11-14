import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, MoveUpRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FeaturedCard, HomeBackgrounds, PublishedUpdate } from "../../shared/contracts";
import type { AppLocale } from "../../shared/locale";
import { useI18n } from "../i18n";

interface NewsCarouselProps {
  updates: PublishedUpdate[];
  /** Cards the site's staff put in front of the publications: temporary events. */
  featured: FeaturedCard[];
  /** Images the staff chose for the back of the page; none keeps the launcher's own art. */
  backgrounds: HomeBackgrounds;
}

/** The images that can really be shown: one that does not load is left out, not shown broken. */
function useLoadedImages(urls: string[]): string[] {
  const [loaded, setLoaded] = useState<string[]>([]);
  const key = urls.join("\n");
  useEffect(() => {
    let current = true;
    setLoaded([]);
    for (const url of urls) {
      const image = new Image();
      // Kept in the staff's order, whatever order they finish loading in.
      image.onload = () => { if (current) setLoaded((known) => urls.filter((candidate) => candidate === url || known.includes(candidate))); };
      image.src = url;
    }
    return () => { current = false; };
  }, [key]);
  return loaded;
}

/** What the block shows, whether it comes from a publication or from a card of the staff. */
interface Slide {
  id: string;
  tag: string;
  meta: string;
  title: string;
  summary: string;
  imageUrl: string;
  /** The back of the page while this slide is shown; empty keeps the page's own. */
  backgroundUrl: string;
  /** Path on the ROTK site, when the slide leads somewhere. */
  path: string | null;
  linkLabel: string;
}

const MAX_SLIDES = 4;

function dateLocale(locale: AppLocale): string {
  return locale === "fr" ? "fr-FR" : locale === "zh" ? "zh-CN" : "en-US";
}

function formattedDate(value: string, locale: AppLocale, fallbackLabel: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return `ROTK / ${fallbackLabel}`;
  return new Intl.DateTimeFormat(dateLocale(locale), {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date).toLocaleUpperCase(dateLocale(locale));
}

export function NewsCarousel({ updates, featured, backgrounds }: NewsCarouselProps) {
  const { locale, copy } = useI18n();
  // The page's own images, and the ones the staff tied to a card: all loaded ahead, to fade without a blank.
  const loaded = useLoadedImages([...new Set([...backgrounds.images, ...featured.map((card) => card.backgroundUrl).filter(Boolean)])]);
  const images = loaded.filter((url) => backgrounds.images.includes(url));
  const [backgroundIndex, setBackgroundIndex] = useState(0);
  const slides = useMemo<Slide[]>(() => {
    const text = (value: Record<AppLocale, string>) => value[locale] || value.en;
    // The site decides which cards are on, and the launcher asks it again every minute.
    const cards = featured
      .map((card): Slide => ({
        id: `featured:${card.id}`,
        tag: text(card.label) || copy.news.featured,
        meta: card.endsAt
          ? copy.events.until(new Intl.DateTimeFormat(dateLocale(locale), { day: "numeric", month: "long" }).format(new Date(card.endsAt))).toLocaleUpperCase(dateLocale(locale))
          : "",
        title: text(card.title),
        summary: text(card.summary),
        imageUrl: card.imageUrl,
        backgroundUrl: card.backgroundUrl,
        path: card.link,
        linkLabel: copy.news.readMore,
      }));
    const publications = updates.slice(0, 2).map((update): Slide => ({
      id: update.id,
      tag: update.type === "patch" ? copy.news.patchNote : copy.news.devUpdate,
      meta: update.version ? `${copy.news.version} ${update.version}` : formattedDate(update.publishedAt, locale, copy.news.fallbackCategory),
      title: update.title,
      summary: update.summary,
      imageUrl: update.coverImageUrl,
      backgroundUrl: "",
      // The site opens the note in the language it was read in here (it knows fr and en).
      path: `/updates/${encodeURIComponent(update.id)}?lang=${locale}`,
      linkLabel: copy.news.readUpdate,
    }));
    const all = [...cards, ...publications].slice(0, MAX_SLIDES);
    return all.length > 0 ? all : [{
      id: "offline",
      tag: copy.news.devUpdate,
      meta: `ROTK / ${copy.news.fallbackCategory}`,
      title: copy.news.fallbackTitle,
      summary: copy.news.fallbackSummary,
      imageUrl: "",
      backgroundUrl: "",
      path: "/updates",
      linkLabel: copy.news.readUpdate,
    }];
  }, [copy, featured, locale, updates]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = useReducedMotion();
  const active = slides[activeIndex % slides.length];

  useEffect(() => {
    if (slides.length < 2 || paused || reduceMotion) return;
    const timer = window.setInterval(() => setActiveIndex((index) => (index + 1) % slides.length), 7_500);
    return () => window.clearInterval(timer);
  }, [paused, reduceMotion, slides.length]);

  useEffect(() => {
    if (activeIndex >= slides.length) setActiveIndex(0);
  }, [activeIndex, slides.length]);

  // The staff's images follow one another when they asked for it; a player who asked for less motion keeps the first.
  const rotateSeconds = backgrounds.rotateSeconds;
  useEffect(() => {
    if (rotateSeconds === null || images.length < 2 || reduceMotion) return;
    const timer = window.setInterval(() => setBackgroundIndex((index) => index + 1), rotateSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [images.length, reduceMotion, rotateSeconds]);
  // A card's own image takes the back of the page while that card is shown; the page's images
  // (and their rotation) come back with the next slide.
  const shownBackground = loaded.includes(active.backgroundUrl)
    ? active.backgroundUrl
    : images[rotateSeconds === null ? 0 : backgroundIndex % Math.max(1, images.length)];

  const summaryLines = active.summary.split("\n").map((line) => line.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);

  const move = (direction: number) => {
    setActiveIndex((index) => (index + direction + slides.length) % slides.length);
  };

  return (
    <section
      className="news-carousel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      aria-label={copy.news.label}
    >
      <div className="news-carousel__visual" aria-hidden="true">
        {images.length === 0 && (
          <motion.div
            className="news-carousel__key-art"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : 1.1, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
        {loaded.map((url) => (
          <div key={url} className="news-carousel__background" data-shown={url === shownBackground} style={{ backgroundImage: `url("${url}")` }} />
        ))}
        <div className="news-carousel__shade" />
      </div>

      <div className="news-carousel__news">
        <div className="news-carousel__heading">
          <span>{copy.news.latest}</span>
          {slides.length > 1 && (
            <span className="news-carousel__count">
              {String(activeIndex + 1).padStart(2, "0")} <i>/</i> {String(slides.length).padStart(2, "0")}
            </span>
          )}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.article
            key={active.id}
            className="news-carousel__content"
            data-cover={active.imageUrl !== ""}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -12 }}
            transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* No image, no frame: the page's own art is the picture then. */}
            {active.imageUrl && (
              <div className="news-carousel__thumbnail" aria-hidden="true">
                <img src={active.imageUrl} alt="" draggable={false} onError={(event) => { (event.currentTarget.parentElement as HTMLElement).style.display = "none"; }} />
              </div>
            )}
            <div className="news-carousel__meta">
              <span>{active.tag}</span>
              {active.meta && <><i /><span>{active.meta}</span></>}
            </div>
            <h2>{active.title}</h2>
            {/* The summary in full: a note written as several lines reads as a list. */}
            {summaryLines.length > 1
              ? <ul className="news-carousel__summary">{summaryLines.slice(0, 4).map((line) => <li key={line}>{line}</li>)}</ul>
              : <p className="news-carousel__summary">{active.summary}</p>}
            {active.path && (
              <button type="button" className="launcher-button launcher-button--ghost" onClick={() => void window.rotk.openWebsite(active.path as string)}>
                {active.linkLabel} <MoveUpRight size={15} aria-hidden="true" />
              </button>
            )}
          </motion.article>
        </AnimatePresence>
      </div>

      {slides.length > 1 && (
        <div className="news-carousel__controls" aria-label={copy.news.navigation}>
          <div className="news-carousel__dots">
            {slides.map((slide, index) => (
              <button
                key={slide.id}
                type="button"
                className={index === activeIndex ? "is-active" : ""}
                aria-label={copy.news.showItem(index + 1)}
                aria-pressed={index === activeIndex}
                onClick={() => setActiveIndex(index)}
              />
            ))}
          </div>
          <div className="news-carousel__arrows">
          <button type="button" aria-label={copy.news.previous} onClick={() => move(-1)}>
            <ArrowLeft size={20} />
          </button>
          <button type="button" aria-label={copy.news.next} onClick={() => move(1)}>
            <ArrowRight size={20} />
          </button>
          </div>
        </div>
      )}
    </section>
  );
}
