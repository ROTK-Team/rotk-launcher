import type { AppLocale } from "../shared/locale";

/** A time left as shown: seconds under a minute, then minutes, then hours and minutes. */
export interface TimeLeft {
  hours: number;
  minutes: number;
  seconds: number;
}

interface DownloadCopy {
  timeLeft(time: TimeLeft): string;
}

const NUMBER_LOCALES: Record<AppLocale, string> = { en: "en-US", fr: "fr-FR", zh: "zh-CN" };

function duration({ hours, minutes, seconds }: TimeLeft, units: { hours: string; minutes: string; seconds: string }): string {
  if (hours > 0) return minutes > 0 ? `${hours} ${units.hours} ${minutes} ${units.minutes}` : `${hours} ${units.hours}`;
  return minutes > 0 ? `${minutes} ${units.minutes}` : `${seconds} ${units.seconds}`;
}

export const DOWNLOAD_COPY: Record<AppLocale, DownloadCopy> = {
  en: {
    timeLeft: (time) => `about ${duration(time, { hours: "h", minutes: "min", seconds: "s" })} left`,
  },
  fr: {
    timeLeft: (time) => {
      const single = (time.hours === 1 && time.minutes === 0) || (time.hours === 0 && time.minutes === 1);
      const text = duration(time, { hours: "h", minutes: "min", seconds: "s" });
      return `environ ${text} ${single ? "restante" : "restantes"}`;
    },
  },
  zh: {
    timeLeft: (time) => `剩余约 ${duration(time, { hours: "小时", minutes: "分钟", seconds: "秒" })}`,
  },
};

/**
 * "312 KB/s" under 1000 KB/s, then "2.4 MB/s". Same units in every language,
 * like the sizes next to it (formatBytes in GlobalActivityCenter).
 */
export function formatDownloadSpeed(bytesPerSecond: number, locale: AppLocale): string {
  const value = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  const kilobytes = Math.round(value / 1024);
  if (kilobytes < 1000) return `${kilobytes} KB/s`;
  const megabytes = new Intl.NumberFormat(NUMBER_LOCALES[locale], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 1024 ** 2);
  return `${megabytes} MB/s`;
}

/**
 * Round an estimate the way it is read: 5 s steps under a minute, whole
 * minutes under an hour, then 5 min steps. Null when there is nothing left.
 */
export function roundTimeLeft(seconds: number): TimeLeft | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const roundedSeconds = Math.ceil(seconds / 5) * 5;
  if (roundedSeconds < 60) return { hours: 0, minutes: 0, seconds: roundedSeconds };
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return { hours: 0, minutes, seconds: 0 };
  const steps = Math.round(seconds / 300) * 5;
  return { hours: Math.floor(steps / 60), minutes: steps % 60, seconds: 0 };
}

export function formatTimeLeft(seconds: number, locale: AppLocale): string | null {
  const time = roundTimeLeft(seconds);
  return time ? DOWNLOAD_COPY[locale].timeLeft(time) : null;
}
