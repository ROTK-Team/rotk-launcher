import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateFeedService } from "../electron/services/update-feed.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const FEED = "https://rotk.app/api/updates";
// What rotk.app answers without a language: English text, and the cover image.
const base = { updates: [
  { id: "patch-1-5-1", type: "patch", title: "Account levels", summary: "Your account now earns XP.", version: "1.5.1",
    coverImage: "/images/levels.jpg", publishedAt: "2026-11-11T09:26:08.338Z" },
  { id: "we-are-growing-up", type: "dev", title: "We are growing up", summary: "More servers.", version: null,
    coverImage: "/images/growing.jpg", publishedAt: "2026-09-01T10:00:00.000Z" },
] };
// What it answers with ?lang=: the text in that language under other names, no cover.
const french = { updates: [
  { id: "patch-1-5-1", type: "patch", title: "Niveaux de compte", highlights: "Votre compte gagne maintenant de l'XP.",
    lang: "fr", languages: ["en", "fr"], publishedAt: "2026-11-11T09:26:08.338Z" },
  { id: "we-are-growing-up", type: "dev", title: "Nous grandissons", highlights: "Plus de serveurs.",
    lang: "fr", languages: ["en", "fr"], publishedAt: "2026-09-01T10:00:00.000Z" },
] };

async function service(routes: Record<string, () => Response>, calls: string[] = []): Promise<UpdateFeedService> {
  const root = await mkdtemp(join(tmpdir(), "rotk-update-feed-test-"));
  roots.push(root);
  return new UpdateFeedService(root, (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed");
    const response = route();
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as typeof fetch);
}
const json = (value: unknown) => () => new Response(JSON.stringify(value));

describe("patch notes in the launcher's language", () => {
  it("shows the translated title and summary, with the cover image of the publication", async () => {
    const calls: string[] = [];
    const feed = await service({ [FEED]: json(base), [`${FEED}?lang=fr`]: json(french) }, calls);
    const updates = await feed.getLatest("fr");
    expect(updates.map((update) => [update.id, update.title, update.summary, update.coverImageUrl])).toEqual([
      ["patch-1-5-1", "Niveaux de compte", "Votre compte gagne maintenant de l'XP.", "https://rotk.app/images/levels.jpg"],
      ["we-are-growing-up", "Nous grandissons", "Plus de serveurs.", "https://rotk.app/images/growing.jpg"],
    ]);
    expect(calls.sort()).toEqual([FEED, `${FEED}?lang=fr`]);
  });

  it("asks only once in English", async () => {
    const calls: string[] = [];
    const feed = await service({ [FEED]: json(base) }, calls);
    expect((await feed.getLatest("en")).map((update) => update.title)).toEqual(["Account levels", "We are growing up"]);
    expect(calls).toEqual([FEED]);
  });

  it("shows the English text when the translation cannot be read", async () => {
    const feed = await service({ [FEED]: json(base), [`${FEED}?lang=fr`]: () => new Response("down", { status: 503 }) });
    expect((await feed.getLatest("fr")).map((update) => update.title)).toEqual(["Account levels", "We are growing up"]);
  });

  it("takes what the site serves for a language it has no translation in", async () => {
    // Asked for Chinese, the site answers in English and says so.
    const english = { updates: base.updates.map(({ summary, coverImage: _cover, ...item }) => ({ ...item, highlights: summary, lang: "en" })) };
    const feed = await service({ [FEED]: json(base), [`${FEED}?lang=zh`]: json(english) });
    expect((await feed.getLatest("zh")).map((update) => update.summary)).toEqual(["Your account now earns XP.", "More servers."]);
  });

  it("keeps the last publications it read when the site cannot be reached", async () => {
    const routes: Record<string, () => Response> = { [FEED]: json(base), [`${FEED}?lang=fr`]: json(french) };
    const feed = await service(routes);
    await feed.getLatest("fr");
    delete routes[FEED];
    delete routes[`${FEED}?lang=fr`];
    expect((await feed.getLatest("fr")).map((update) => update.title)).toEqual(["Niveaux de compte", "Nous grandissons"]);
  });
});
