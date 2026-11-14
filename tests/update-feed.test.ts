import { describe, expect, it } from "vitest";
import { updateFeedInternals } from "../electron/services/update-feed.js";

function update(
  id: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "patch",
    title: id,
    summary: "Published on rotk.app",
    version: "1.0.0",
    publishedAt: "2026-07-17T13:53:00.000Z",
    ...fields,
  };
}

describe("ROTK update feed parsing", () => {
  it("uses the official rotk.app API instead of Firebase", () => {
    const url = new URL(updateFeedInternals.feedUrl);
    expect(url.origin).toBe("https://rotk.app");
    expect(url.pathname).toBe("/api/updates");
    expect(url.search).toBe("");
    expect(updateFeedInternals.feedUrl).not.toContain("firebase");
    expect(updateFeedInternals.feedUrl).not.toContain("firestore");
  });

  it("keeps the newest patch note first and at most two publications", () => {
    const parsed = updateFeedInternals.parseFeed({
      updates: [
        update("old-patch", { publishedAt: "2026-07-15T10:00:00.000Z" }),
        update("latest-dev", {
          type: "dev",
          title: "Latest dev update",
          coverImage: "/images/atv-run.jpg",
          publishedAt: "2026-07-18T13:53:00.000Z",
        }),
        update("latest-patch", {
          title: "Latest patch",
          version: "1.3.32",
          publishedAt: "2026-07-17T13:12:00.000Z",
        }),
        update("ignored-news", {
          type: "news",
          title: "Unsupported",
          publishedAt: "2026-07-19T00:00:00.000Z",
        }),
        update("invalid-date", { publishedAt: "not-a-date" }),
      ],
    });

    expect(parsed.map((item) => item.id)).toEqual(["latest-patch", "latest-dev"]);
    expect(parsed[0].siteUrl).toBe("https://rotk.app/updates/latest-patch");
    expect(parsed[1].coverImageUrl).toBe("https://rotk.app/images/atv-run.jpg");
  });

  it("parses the nullable fields returned by the VPS API", () => {
    const parsed = updateFeedInternals.parseFeed({
      updates: [
        update("patch-1-3-32", {
          title: "Patch Note — SAISON 0 !",
          category: null,
          coverImage: "/images/combat-smoke.jpg",
          version: "1.3.32",
          publishedAt: "2026-08-15T22:31:45.617Z",
        }),
      ],
    });

    expect(parsed[0]).toMatchObject({
      id: "patch-1-3-32",
      type: "patch",
      category: "",
      version: "1.3.32",
      coverImageUrl: "https://rotk.app/images/combat-smoke.jpg",
      siteUrl: "https://rotk.app/updates/patch-1-3-32",
    });
  });

  it("does not allow third-party or insecure cover images", () => {
    expect(updateFeedInternals.normalizeCoverImage("https://evil.example/image.jpg")).toBe("");
    expect(updateFeedInternals.normalizeCoverImage("http://rotk.app/image.jpg")).toBe("");
    expect(updateFeedInternals.normalizeCoverImage("/images/fireline.jpg")).toBe(
      "https://rotk.app/images/fireline.jpg",
    );
  });

  it("bounds text and URL-encodes update ids", () => {
    const parsed = updateFeedInternals.parseFeed({
      updates: [
        update("patch update #1", {
          title: "T".repeat(200),
          summary: "S".repeat(1_500),
          category: "C".repeat(100),
        }),
      ],
    });

    expect(parsed[0].title).toHaveLength(120);
    expect(parsed[0].summary).toHaveLength(1_200);
    expect(parsed[0].category).toHaveLength(64);
    expect(parsed[0].siteUrl).toBe("https://rotk.app/updates/patch%20update%20%231");
  });

  it("rejects malformed top-level responses", () => {
    expect(() => updateFeedInternals.parseFeed([])).toThrow("Unexpected update feed response");
    expect(() => updateFeedInternals.parseFeed({ updates: null })).toThrow(
      "Unexpected update feed response",
    );
  });
});
