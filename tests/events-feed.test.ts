import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchEvents, fetchHomeChoice, parseBackgrounds, parseBanner, parseEvents, parseFeatured } from "../electron/services/events-feed.js";

const season = (overrides: Record<string, unknown>) => ({
  key: "lame-eu-solos-s1", name: "SOLO QUALIFIER #4", creatorName: "Lame", mode: "solo", region: "eu", type: "tournament",
  phase: "applications", listed: true, suspendedAt: null, startsAt: "2026-11-13T17:35:27.321Z", applicationsCloseAt: "2026-11-14T14:00:00.000Z",
  ...overrides,
});

describe("events shown on the home page", () => {
  it("keeps what is open or running, the running ones first", () => {
    const events = parseEvents({ seasons: [
      season({}),
      season({ key: "done", phase: "completed" }),
      season({ key: "draft", phase: "draft" }),
      season({ key: "hidden", listed: false }),
      season({ key: "paused", suspendedAt: "2026-11-14T10:00:00.000Z" }),
      season({ key: "live league", phase: "running", type: "league", name: "ROTK LEAGUE" }),
      null,
      { phase: "running", listed: true },
    ] });
    expect(events.map((event) => event.id)).toEqual(["live league", "lame-eu-solos-s1"]);
    expect(events[0]).toMatchObject({ phase: "running", sitePath: "/league?season=live%20league" });
    expect(events[1]).toMatchObject({ host: "Lame", mode: "solo", region: "eu", sitePath: "/tournaments?season=lame-eu-solos-s1" });
  });

  it("leaves out a date it cannot read and refuses an answer that is not the list", () => {
    expect(parseEvents({ seasons: [season({ startsAt: "soon", applicationsCloseAt: 12 })] })[0])
      .toMatchObject({ startsAt: null, applicationsCloseAt: null });
    expect(() => parseEvents({ error: "nope" })).toThrow();
  });

  it("only trusts an answer that comes from rotk.app", async () => {
    const answer = (url: string) => (async () => ({ ok: true, url, text: async () => JSON.stringify({ seasons: [season({})] }) })) as unknown as typeof fetch;
    expect(await fetchEvents(answer("https://rotk.app/api/competitions"))).toHaveLength(1);
    await expect(fetchEvents(answer("https://example.com/api/competitions"))).rejects.toThrow();
  });
});

describe("the line of the home page chosen on the site", () => {
  it("keeps the staff's message as plain text and a link only when it is a site path", () => {
    const banner = parseBanner({ banner: { mode: "message", message: { en: "  Servers restart\n at 3:00  ", fr: "x".repeat(300) }, link: "/updates", eventKey: "" } });
    expect(banner).toEqual({ enabled: true, mode: "message", messages: [{ text: { en: "Servers restart at 3:00", fr: "x".repeat(200), zh: "" }, link: "/updates" }], eventKey: null });
    // A tab or a line break is dropped when the address is resolved: "/<tab>/host" leads to another site.
    for (const link of ["https://example.com", "//example.com", "updates", "/a\\b", 12, "/\t/example.com/x", "/\n/example.com", "/\r\n/example.com"]) {
      expect(parseBanner({ banner: { mode: "message", message: { en: "hi" }, link } }).messages[0].link).toBeNull();
    }
  });

  it("reads the staff's list of messages when the site gives one, five at most, English required", () => {
    const entry = (en: string, link: unknown = null) => ({ message: { en }, link });
    const banner = parseBanner({ banner: {
      mode: "message", message: { en: "first" }, link: "/updates",
      messages: [entry("first", "/updates"), entry(""), entry("second", "//example.com"), ...Array.from({ length: 6 }, (_, at) => entry(`more ${at}`))],
    } });
    expect(banner.messages.map((message) => [message.text.en, message.link])).toEqual([["first", "/updates"], ["second", null], ["more 0", null], ["more 1", null]]);
    expect(parseBanner({ banner: { mode: "news", message: { en: "" }, link: null, messages: [] } }).messages).toEqual([]);
  });

  it("reads a mode it does not know as no choice, and keeps the cards and the images of an answer without a line", async () => {
    expect(parseBanner({ banner: { mode: "takeover", message: { en: "kept" } } })).toMatchObject({ mode: "auto", messages: [{ text: { en: "kept" } }] });
    expect(() => parseBanner({})).toThrow();
    const answer = (body: unknown) => (async () => ({ ok: true, url: "https://rotk.app/api/launcher/banner", text: async () => JSON.stringify(body) })) as unknown as typeof fetch;
    expect(await fetchHomeChoice(answer({ featured: [{ id: "xp", title: { en: "Double XP" } }], backgrounds: { images: ["/media/a.jpg"] } })))
      .toMatchObject({ banner: null, featured: [{ id: "xp" }], backgrounds: { images: ["https://rotk.app/media/a.jpg"] } });
    expect(parseBanner({ banner: { mode: "event", eventKey: "lame-eu-solos-s1" } })).toMatchObject({ mode: "event", eventKey: "lame-eu-solos-s1", messages: [] });
    // The site has no such address yet: the read fails and nothing changes.
    const missing = (async () => ({ ok: false, status: 404, url: "https://rotk.app/api/launcher/banner", text: async () => "" })) as unknown as typeof fetch;
    await expect(fetchHomeChoice(missing)).rejects.toThrow();
  });

  it("turns the line off only when the site says so", () => {
    expect(parseBanner({ banner: { mode: "message", enabled: false, message: { en: "kept" } } })).toMatchObject({ enabled: false, mode: "message", messages: [{ text: { en: "kept" } }] });
    expect(parseBanner({ banner: { mode: "auto" } }).enabled).toBe(true);
  });

  it("keeps the staff's cards the site gives, with links and images of the site only", () => {
    const card = (overrides: Record<string, unknown>) => ({ id: "double-xp", title: { en: "Double XP weekend", fr: "Week-end double XP" }, summary: { en: "Line one\nLine two" }, ...overrides });
    const featured = parseFeatured({ featured: [
      card({ label: { en: "WEEKEND EVENT" }, image: "/media/xp.jpg", background: "/api/launcher/images/back.webp", link: "/tournaments", endsAt: "2026-11-16T22:00:00.000Z" }),
      card({ id: "untitled", title: { fr: "Sans anglais" } }),
      card({ id: "elsewhere", image: "https://example.com/x.jpg", background: "//example.com/back.jpg", link: "//example.com" }),
      null,
    ] });
    expect(featured.map((item) => item.id)).toEqual(["double-xp", "elsewhere"]);
    expect(featured[0]).toEqual({
      id: "double-xp", label: { en: "WEEKEND EVENT", fr: "", zh: "" }, title: { en: "Double XP weekend", fr: "Week-end double XP", zh: "" },
      summary: { en: "Line one\nLine two", fr: "", zh: "" }, imageUrl: "https://rotk.app/media/xp.jpg", backgroundUrl: "https://rotk.app/api/launcher/images/back.webp", link: "/tournaments", endsAt: "2026-11-16T22:00:00.000Z",
    });
    expect(featured[1]).toMatchObject({ imageUrl: "", backgroundUrl: "", link: null });
    expect(parseFeatured({ banner: { mode: "auto" } })).toEqual([]);
    // Which cards are on is the site's decision, with its clock: a PC whose clock is wrong shows them all the same.
    expect(parseFeatured({ featured: [card({ id: "over here", endsAt: "2001-01-01T00:00:00.000Z" }), card({ id: "later here", startsAt: "2999-01-01T00:00:00.000Z" })] })
      .map((item) => item.id)).toEqual(["over here", "later here"]);
  });
});

describe("the answer the site really publishes", () => {
  // A copy, byte for byte, of the example the site's server tests its public answer against:
  // server-rust/crates/web/src/handlers/launcher_banner.published.json in ROTK-Team/rotk.
  const published = readFileSync(new URL("./fixtures/launcher-banner.published.json", import.meta.url), "utf8");

  it("is read whole: the line and its messages, the cards, the images", async () => {
    const site = (async () => ({ ok: true, url: "https://rotk.app/api/launcher/banner", text: async () => published })) as unknown as typeof fetch;
    const image = "https://rotk.app/api/launcher/images/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const none = { en: "", fr: "", zh: "" };
    expect(await fetchHomeChoice(site)).toEqual({
      banner: {
        enabled: true,
        mode: "message",
        messages: [
          { text: { en: "Servers restart tonight at 6 pm CET", fr: "Redémarrage des serveurs ce soir à 18 h", zh: "" }, link: "/updates" },
          { text: { en: "Double Crowns all weekend", fr: "", zh: "本周末双倍 Crowns" }, link: null },
        ],
        eventKey: null,
      },
      featured: [
        {
          id: "double-crowns",
          label: { en: "LIVE NOW", fr: "EN COURS", zh: "" },
          title: { en: "Double Crowns weekend", fr: "Week-end double Crowns", zh: "" },
          summary: { en: "Crowns ×2 on every placement.\n3 skins to win in game.", fr: "", zh: "" },
          imageUrl: "https://rotk.app/images/final-duel.jpg",
          backgroundUrl: `${image}.webp`,
          link: "/tournaments",
          endsAt: "2026-11-16T17:00:00.000Z",
        },
        { id: "plain", label: none, title: { ...none, en: "Winter map" }, summary: none, imageUrl: "", backgroundUrl: "", link: null, endsAt: null },
      ],
      backgrounds: { images: [`${image}.jpg`, "https://rotk.app/images/gas-ridge.webp"], rotateSeconds: 20 },
    });
  });
});

describe("the images behind the home page chosen on the site", () => {
  it("keeps site paths only, and rotates when asked to and there is more than one", () => {
    const images = ["/media/a.jpg", "https://example.com/b.jpg", "//example.com/c.jpg", "/media/d.webp", 7];
    expect(parseBackgrounds({ backgrounds: { mode: "rotate", seconds: 2, images } }))
      .toEqual({ images: ["https://rotk.app/media/a.jpg", "https://rotk.app/media/d.webp"], rotateSeconds: 5 });
    expect(parseBackgrounds({ backgrounds: { mode: "single", seconds: 30, images } }).rotateSeconds).toBeNull();
    expect(parseBackgrounds({ backgrounds: { mode: "rotate", images: ["/media/a.jpg"] } }).rotateSeconds).toBeNull();
    expect(parseBackgrounds({ backgrounds: { mode: "rotate", seconds: 900, images } }).rotateSeconds).toBe(120);
    expect(parseBackgrounds({ backgrounds: { images: ["/\t/example.com/x.jpg", "/media/a b.jpg?v=1"] } }).images).toEqual(["https://rotk.app/media/a%20b.jpg?v=1"]);
  });

  it("keeps the launcher's own art when the site sends nothing", () => {
    expect(parseBackgrounds({ banner: { mode: "auto" } })).toEqual({ images: [], rotateSeconds: null });
    expect(parseBackgrounds({ backgrounds: { images: "all of them" } })).toEqual({ images: [], rotateSeconds: null });
  });
});
