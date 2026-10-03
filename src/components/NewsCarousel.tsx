import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, MoveUpRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PublishedUpdate } from "../../shared/contracts";
import type { AppLocale } from "../../shared/locale";
import { useI18n } from "../i18n";

interface NewsCarouselProps {
  updates: PublishedUpdate[];
}

const FALLBACK_UPDATE: PublishedUpdate = {
  id: "offline",
  type: "dev",
  title: "RETURN OF THE KING",
  summary: "",
  version: null,
  category: "DEVELOPMENT",
  coverImageUrl: "",
  publishedAt: new Date(0).toISOString(),
  siteUrl: "https://rotk.app/updates",
};

function formattedDate(value: string, locale: AppLocale, fallbackLabel: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return `ROTK / ${fallbackLabel}`;
  const dateLocale = locale === "fr" ? "fr-FR" : locale === "zh" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(dateLocale, {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date).toLocaleUpperCase(dateLocale);
}

export function NewsCarousel({ updates }: NewsCarouselProps) {
  const { locale, copy } = useI18n();
  const fallback = useMemo<PublishedUpdate>(
    () => ({ ...FALLBACK_UPDATE, title: copy.news.fallbackTitle, summary: copy.news.fallbackSummary, category: copy.news.fallbackCategory }),
    [copy.news.fallbackCategory, copy.news.fallbackSummary, copy.news.fallbackTitle],
  );
  const slides = useMemo(() => (updates.length > 0 ? updates.slice(0, 2) : [fallback]), [fallback, updates]);
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

  const move = (direction: number) => {
    setActiveIndex((index) => (index + direction + slides.length) % slides.length);
  };

  const openActive = () => {
    const path = active.id === "offline" ? "/updates" : `/updates/${encodeURIComponent(active.id)}`;
    void window.rotk.openWebsite(path);
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
        <motion.div
          className="news-carousel__key-art"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduceMotion ? 0 : 1.1, ease: [0.22, 1, 0.36, 1] }}
        />
        <div className="news-carousel__shade" />
      </div>

      <motion.div
        className="launcher-brand"
        initial={{ opacity: 0, y: reduceMotion ? 0 : 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.65, delay: reduceMotion ? 0 : 0.12 }}
      >
        <div className="launcher-brand__eyebrow">RETURN OF THE KING <i /> BATTLE ROYALE</div>
        <h1><img src="./branding/rotk-wordmark-red-skull.svg" alt="ROTK" draggable={false} /></h1>
        <p>{copy.news.headline}</p>
      </motion.div>

      <div className="news-carousel__news">
        <div className="news-carousel__heading">
          <span>{copy.news.latest}</span>
          <span className="news-carousel__count">
            {String(activeIndex + 1).padStart(2, "0")} <i>/</i> {String(slides.length).padStart(2, "0")}
          </span>
        </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.article
          key={active.id}
          className="news-carousel__content"
          initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduceMotion ? 0 : -12 }}
          transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="news-carousel__thumbnail" aria-hidden="true">
            {active.coverImageUrl && <img src={active.coverImageUrl} alt="" draggable={false} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />}
          </div>
          <div className="news-carousel__copy">
          <div className="news-carousel__meta">
            <span>{active.type === "patch" ? copy.news.patchNote : copy.news.devUpdate}</span>
            <i />
            <span>{active.version ? `${copy.news.version} ${active.version}` : formattedDate(active.publishedAt, locale, copy.news.fallbackCategory)}</span>
          </div>
          <h2>{active.title}</h2>
          <p>{active.summary}</p>
          <button type="button" className="editorial-link" onClick={openActive}>
            {copy.news.readUpdate} <MoveUpRight size={16} />
          </button>
          </div>
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
