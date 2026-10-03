import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { retryFs } from "./fs-safe.js";
import { dirname, join } from "node:path";
import type { PublishedUpdate } from "../../shared/contracts.js";
import { WEBSITE_ORIGIN } from "../constants.js";

const UPDATE_FEED_URL = `${WEBSITE_ORIGIN}/api/updates`;
const MAX_FEED_BYTES = 1_000_000;

interface PublishedUpdateApiItem {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  summary?: unknown;
  version?: unknown;
  category?: unknown;
  coverImage?: unknown;
  publishedAt?: unknown;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCoverImage(value: string): string {
  try {
    const url = new URL(value, WEBSITE_ORIGIN);
    if (url.protocol === "https:" && url.origin === WEBSITE_ORIGIN) return url.href;
  } catch {
    // Invalid remote image: the renderer will use its branded fallback.
  }
  return "";
}

/**
 * Keeps the newest patch note first so the launcher always opens on the most
 * recent game release. The second carousel slot remains available for the
 * newest other publication (or the previous patch note).
 */
function selectLauncherUpdates(updates: PublishedUpdate[]): PublishedUpdate[] {
  const sorted = [...updates].sort(
    (left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
  );
  const latestPatch = sorted.find((update) => update.type === "patch");
  if (!latestPatch) return sorted.slice(0, 2);
  return [latestPatch, ...sorted.filter((update) => update.id !== latestPatch.id)].slice(0, 2);
}

function parseFeed(value: unknown): PublishedUpdate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected update feed response");
  }

  const entries = (value as { updates?: unknown }).updates;
  if (!Array.isArray(entries)) throw new Error("Unexpected update feed response");

  const updates: PublishedUpdate[] = [];
  for (const entry of entries as PublishedUpdateApiItem[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const id = readString(entry.id);
    const type = readString(entry.type);
    const title = readString(entry.title);
    const publishedAt = readString(entry.publishedAt);
    if (
      !id ||
      !title ||
      !publishedAt ||
      !Number.isFinite(Date.parse(publishedAt)) ||
      (type !== "dev" && type !== "patch")
    ) {
      continue;
    }

    updates.push({
      id,
      type,
      title: title.slice(0, 120),
      summary: readString(entry.summary).slice(0, 360),
      version: readString(entry.version) || null,
      category: readString(entry.category).slice(0, 64),
      coverImageUrl: normalizeCoverImage(readString(entry.coverImage)),
      publishedAt,
      siteUrl: `${WEBSITE_ORIGIN}/updates/${encodeURIComponent(id)}`,
    });
  }

  return selectLauncherUpdates(updates);
}

function isCachedUpdate(value: unknown): value is PublishedUpdate {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PublishedUpdate>;
  return (
    typeof item.id === "string" &&
    (item.type === "dev" || item.type === "patch") &&
    typeof item.title === "string" &&
    typeof item.summary === "string" &&
    typeof item.publishedAt === "string" &&
    typeof item.siteUrl === "string" &&
    item.siteUrl.startsWith(`${WEBSITE_ORIGIN}/updates/`)
  );
}

export class UpdateFeedService {
  private readonly cachePath: string;

  constructor(userDataDirectory: string) {
    // v2 deliberately ignores the old Firestore-backed cache.
    this.cachePath = join(userDataDirectory, "updates-cache.v2.json");
  }

  async getLatest(): Promise<PublishedUpdate[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7_000);
      let response: Response;
      try {
        response = await fetch(UPDATE_FEED_URL, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
      const responseUrl = new URL(response.url || UPDATE_FEED_URL);
      if (responseUrl.protocol !== "https:" || responseUrl.origin !== WEBSITE_ORIGIN) {
        throw new Error("Feed redirected outside rotk.app");
      }
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_FEED_BYTES) throw new Error("Feed too large");
      const updates = parseFeed(JSON.parse(body));
      if (updates.length === 0) throw new Error("Feed empty");
      await this.writeCache(updates);
      return updates;
    } catch {
      return this.readCache();
    }
  }

  private async readCache(): Promise<PublishedUpdate[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.cachePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isCachedUpdate).slice(0, 2) : [];
    } catch {
      return [];
    }
  }

  private async writeCache(updates: PublishedUpdate[]): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(updates, null, 2)}\n`, "utf8");
    await retryFs(() => rename(temporary, this.cachePath));
  }
}

export const updateFeedInternals = {
  parseFeed,
  normalizeCoverImage,
  feedUrl: UPDATE_FEED_URL,
};
