import { describe, expect, it } from "vitest";
import {
  buildPlaceProfile,
  clampSentiment,
  isVerbatim,
  keepVerbatimEvidence,
  normalizeDish,
  quoteRange,
  type ReviewAnalysis,
  type ReviewInput,
  recencyWeight,
  reviewsNeedingAnalysis,
} from "./reviews";

const NOW = "2026-11-21T00:00:00Z";
const KEY = "0x1:0x2";

function review(id: string, text = `review ${id}`, publishedAt?: string): ReviewInput {
  return { id, text, publishedAt, contentHash: `h-${id}` };
}

function analysis(reviewId: string, over: Partial<ReviewAnalysis> = {}): ReviewAnalysis {
  return {
    reviewId,
    sourcePlaceKey: KEY,
    classifier: "test",
    promptVersion: "1",
    contentHash: `h-${reviewId}`,
    analysedAt: NOW,
    useful: true,
    sentiment: 1,
    aspects: [],
    dishes: [],
    occasions: [],
    dietary: [],
    vibes: [],
    practical: {},
    redFlags: [],
    ...over,
  };
}

describe("evidence", () => {
  it("accepts verbatim quotes across case, whitespace and typographic quotes", () => {
    const text = "The  cacio e pepe was “perfect” — honestly the best.";
    expect(isVerbatim('cacio e pepe was "perfect"', text)).toBe(true);
    expect(isVerbatim("THE BEST", text)).toBe(true);
    expect(isVerbatim("the carbonara was perfect", text)).toBe(false);
    expect(isVerbatim("ok", text)).toBe(false);
  });

  it("drops non-verbatim quotes and keeps the rest of the analysis", () => {
    const a = analysis("r1", {
      aspects: [
        { aspect: "food", sentiment: 2, quote: "great pasta" },
        { aspect: "service", sentiment: -1, quote: "invented quote" },
      ],
    });
    const kept = keepVerbatimEvidence(a, "Great pasta, slow waiter.");
    expect(kept.aspects).toEqual([
      { aspect: "food", sentiment: 2, quote: "great pasta" },
      { aspect: "service", sentiment: -1, quote: undefined },
    ]);
  });

  it("locates a quote for highlighting", () => {
    expect(quoteRange("great pasta", "Really great pasta.")).toEqual([7, 18]);
    expect(quoteRange("missing", "Really great pasta.")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("clamps sentiment to the five-step scale", () => {
    expect(clampSentiment(5)).toBe(2);
    expect(clampSentiment(-3.2)).toBe(-2);
    expect(clampSentiment(0.6)).toBe(1);
    expect(clampSentiment(Number.NaN)).toBe(0);
  });

  it("normalizes dish names", () => {
    expect(normalizeDish("The Pastéis de Nata!")).toBe("pasteis de nata");
    expect(normalizeDish("cacio-e-pepe")).toBe("cacio e pepe");
  });

  it("halves the weight of a review every year", () => {
    expect(recencyWeight(undefined, NOW)).toBe(1);
    expect(recencyWeight("2025-11-21T00:00:00Z", NOW)).toBeCloseTo(0.5, 2);
  });

  it("finds reviews with missing or stale analyses", () => {
    const reviews = [
      review("a"),
      review("b"),
      { ...review("c"), contentHash: "changed" },
      review("d", "  "),
    ];
    const analyses = [analysis("a"), analysis("c"), analysis("b", { promptVersion: "0" })];
    expect(reviewsNeedingAnalysis(reviews, analyses, "test", "1").map((r) => r.id)).toEqual([
      "b",
      "c",
    ]);
  });
});

describe("buildPlaceProfile", () => {
  it("aggregates aspects, dishes, price, tags and warnings", () => {
    const reviews = ["1", "2", "3", "4", "5"].map((id) => review(id));
    const analyses = [
      analysis("1", {
        aspects: [{ aspect: "food", sentiment: 2 }],
        dishes: [{ name: "Cacio e pepe", normalized: "cacio e pepe", sentiment: 2 }],
        vibes: ["cozy"],
        price: { signal: "moderate" },
        redFlags: [{ flag: "rude_staff" }],
      }),
      analysis("2", {
        aspects: [
          { aspect: "food", sentiment: 1 },
          { aspect: "service", sentiment: -2 },
        ],
        dishes: [{ name: "cacio-e-pepe", normalized: "cacio e pepe", sentiment: 1 }],
        vibes: ["cozy", "loud"],
        price: { signal: "moderate" },
        redFlags: [{ flag: "rude_staff" }],
      }),
      analysis("3", {
        vibes: ["cozy"],
        dietary: [{ tag: "vegetarian", served: "poorly" }],
        price: { signal: "pricey" },
      }),
      analysis("4", { useful: false, vibes: ["loud"] }),
      analysis("5", { contentHash: "stale", vibes: ["loud"] }),
    ];
    const p = buildPlaceProfile(KEY, reviews, analyses, NOW);
    expect(p.reviewCount).toBe(5);
    expect(p.analysedCount).toBe(4); // the stale one is ignored
    expect(p.usefulCount).toBe(3);
    expect(p.aspects).toEqual([
      { aspect: "food", score: 1.5, mentions: 2 },
      { aspect: "service", score: -2, mentions: 1 },
    ]);
    expect(p.dishes[0]).toMatchObject({ name: "Cacio e pepe", mentions: 2, score: 1.5 });
    expect(p.price).toEqual({ signal: "moderate", mentions: 2 });
    // cozy reaches the 3-mention floor; loud's other mentions are not useful or stale.
    expect(p.tags).toEqual([{ kind: "vibe", tag: "cozy", mentions: 3 }]);
    expect(p.warnings).toEqual([{ flag: "rude_staff", mentions: 2, reviewIds: ["1", "2"] }]);
  });

  it("ignores old red flags and weights recent reviews higher", () => {
    const reviews = [
      review("old", "x", "2022-01-01T00:00:00Z"),
      review("old2", "x", "2022-02-01T00:00:00Z"),
      review("new", "x", "2026-11-01T00:00:00Z"),
    ];
    const analyses = [
      analysis("old", {
        redFlags: [{ flag: "food_safety" }],
        aspects: [{ aspect: "food", sentiment: -2 }],
      }),
      analysis("old2", { redFlags: [{ flag: "food_safety" }] }),
      analysis("new", { aspects: [{ aspect: "food", sentiment: 2 }] }),
    ];
    const p = buildPlaceProfile(KEY, reviews, analyses, NOW);
    expect(p.warnings).toEqual([]);
    expect(p.aspects[0]?.score).toBeGreaterThan(1.5);
  });

  it("prefers the first analysis listed when a review has several", () => {
    const reviews = [review("1")];
    const p = buildPlaceProfile(
      KEY,
      reviews,
      [analysis("1", { classifier: "a", sentiment: 2 }), analysis("1", { classifier: "b" })],
      NOW,
    );
    expect(p.classifiers).toEqual(["a"]);
  });
});
