import { readFileSync } from "node:fs";
import path from "node:path";
import { harvestPhotoSchema, harvestReviewSchema } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import {
  buildInputFile,
  buildScraperArgs,
  collectResults,
  normalizeGosomEntry,
  parseResults,
} from "./gosom";

const fixture = readFileSync(
  path.join(import.meta.dirname, "../../fixtures/gosom-results.jsonl"),
  "utf8",
);
const fetchedAt = "2026-11-21T00:00:00.000Z";

describe("gosom input and arguments", () => {
  it("tags each input line with its index so results map back", () => {
    expect(
      buildInputFile([
        { query: "https://www.google.com/maps/place/A", kind: "url" },
        { query: "ramen\nin Shoreditch", kind: "search" },
      ]),
    ).toBe("https://www.google.com/maps/place/A #!#0\nramen in Shoreditch #!#1\n");
  });

  it("runs politely: one page at a time, JSON output, extra reviews on request", () => {
    const args = buildScraperArgs(
      { extraReviews: true, depth: 3, language: "en" },
      { input: "/work/q.txt", results: "/work/r.json" },
    );
    expect(args).toEqual(expect.arrayContaining(["-json", "-extra-reviews", "-c", "1"]));
    expect(args.join(" ")).toContain("-input /work/q.txt -results /work/r.json");
  });

  it("passes a radius search or a strict grid box", () => {
    const geo = buildScraperArgs(
      {
        extraReviews: false,
        depth: 1,
        language: "en",
        area: { geo: { lat: 51.5, lng: -0.1 }, radiusMeters: 800 },
      },
      { input: "i", results: "r" },
    ).join(" ");
    expect(geo).toContain("-geo 51.5,-0.1 -radius 800");
    expect(geo).not.toContain("-extra-reviews");
    const box = buildScraperArgs(
      { extraReviews: false, depth: 1, language: "en", area: { bbox: [51.5, -0.1, 51.6, 0] } },
      { input: "i", results: "r" },
    ).join(" ");
    expect(box).toContain("-grid-bbox 51.5,-0.1,51.6,0");
    expect(box).toContain("-grid-strict");
  });
});

describe("normalizing scraper output", () => {
  const entries = parseResults(fixture);
  const first = entries[0];
  if (!first) throw new Error("fixture is empty");
  const normalized = normalizeGosomEntry(first, fetchedAt);
  if ("error" in normalized) throw new Error(normalized.error);

  it("parses JSON Lines and JSON arrays alike", () => {
    expect(entries).toHaveLength(4);
    expect(parseResults(JSON.stringify(entries))).toHaveLength(4);
    expect(parseResults("")).toEqual([]);
  });

  it("keys the place by the lowercase feature id and keeps the Google ids", () => {
    const { place } = normalized;
    expect(place.sourcePlaceKey).toBe("0x487604a9c3b0d5f7:0x2b5e3f0c1d2a4b6c");
    expect(place.googlePlaceId).toBe("ChIJ99WwwwkEdkgRbEsqHQw_Xis");
    expect(place.cid).toBe("3124567890123456876");
  });

  it("maps the place facts", () => {
    const { place } = normalized;
    expect(place).toMatchObject({
      name: "Bar Douro",
      lat: 51.5045,
      lng: -0.0946,
      rating: 4.7,
      ratingCount: 1843,
      priceLevel: 2,
      types: ["Portuguese restaurant", "Tapas bar"],
      ratingHistogram: { "1": 21, "2": 18, "3": 60, "4": 250, "5": 1494 },
      openingHours: ["Monday: Closed", "Tuesday: 12–3 PM, 5:30–10 PM"],
      provider: "gosom",
    });
  });

  it("records how complete the review download was", () => {
    expect(normalized.place.reviewCollection).toEqual({
      status: "limited",
      collected: 3,
      expected: 1843,
      reason: "Google served a limited view",
    });
  });

  it("dedupes reviews across both arrays, keeping the longer text", () => {
    const ana = normalized.reviews.filter((r) => r.authorName === "Ana P.");
    expect(ana).toHaveLength(1);
    expect(ana[0]?.text).toBe("Best octopus in London. Book ahead.");
  });

  it("keeps translations, owner replies, rating-only reviews; drops empty ones", () => {
    const byAuthor = new Map(normalized.reviews.map((r) => [r.authorName, r]));
    expect(byAuthor.get("Jörg")).toMatchObject({
      text: "Gut, aber laut.",
      originalLanguage: "de",
      translatedText: "Good, but loud.",
      translatedLanguage: "en",
      rating: 3,
    });
    expect(byAuthor.get("Rating only")).toMatchObject({ text: "", rating: 4 });
    expect(byAuthor.has("Empty")).toBe(false);
  });

  it("produces schema-valid reviews with stable ids and content hashes", () => {
    for (const review of normalized.reviews) harvestReviewSchema.parse(review);
    const again = normalizeGosomEntry(first, "2026-12-01T00:00:00.000Z");
    if ("error" in again) throw new Error(again.error);
    expect(again.reviews.map((r) => [r.id, r.contentHash])).toEqual(
      normalized.reviews.map((r) => [r.id, r.contentHash]),
    );
  });

  it("collects place and review photos with attribution, skipping blank URLs", () => {
    expect(normalized.photos).toHaveLength(2);
    for (const photo of normalized.photos) harvestPhotoSchema.parse(photo);
    const reviewPhoto = normalized.photos.find((p) => p.reviewId);
    expect(reviewPhoto?.attribution).toEqual({
      name: "Ana P.",
      url: "https://www.google.com/maps/contrib/1001",
    });
  });

  it("reports entries without coordinates or ids instead of dropping them", () => {
    const result = collectResults(entries, 2, fetchedAt);
    expect(result.places.map((p) => p.inputIndex)).toEqual([0]);
    expect(result.failures).toEqual([
      { inputIndex: 1, error: "no name or coordinates for 0x1:0x2" },
      { inputIndex: 1, error: 'no Google id for "No id"' },
    ]);
  });
});
