import { describe, expect, it } from "vitest";
import type { Place } from "./entities";
import {
  compactFilter,
  foldText,
  isEmptyFilter,
  matchesFilter,
  normalizeTag,
  normalizeTags,
  type PlaceFacets,
  placeKindLine,
  prettyFact,
  tagCounts,
} from "./library";

const place = (over: Partial<Place> = {}): Place => ({
  id: "p1",
  name: "Café Kiln",
  lat: 51.5,
  lng: -0.13,
  origin: "search",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const facets = (over: Partial<Place> = {}, rest: Partial<PlaceFacets> = {}): PlaceFacets => ({
  place: place(over),
  listIds: [],
  derivedTags: [],
  ...rest,
});

describe("tags", () => {
  it("normalises case, whitespace and a leading hash", () => {
    expect(normalizeTag("  #Date   Night ")).toBe("date night");
    expect(normalizeTags(["Wine", "wine", " ", "brunch"])).toEqual(["brunch", "wine"]);
  });

  it("counts tags most used first, then alphabetically", () => {
    expect(tagCounts([["b", "a"], ["b"], ["c"]])).toEqual([
      { tag: "b", count: 2 },
      { tag: "a", count: 1 },
      { tag: "c", count: 1 },
    ]);
  });
});

describe("foldText", () => {
  it("drops diacritics and provider punctuation", () => {
    expect(foldText("Pastéis de Belém")).toBe("pasteis de belem");
    expect(foldText("Coffee_shop;Australian")).toBe("coffee shop australian");
  });
});

describe("matchesFilter", () => {
  it("matches every word of free text across different fields, in any order", () => {
    const f = facets({ tags: ["cosy"], cuisine: "italian", address: "Brewer Street, Soho" });
    expect(matchesFilter(f, { text: "cosy italian soho" })).toBe(true);
    expect(matchesFilter(f, { text: "soho thai" })).toBe(false);
  });

  it("finds a place by its note, by review-derived tags and by review text", () => {
    const f = facets(
      { note: "Ask for the back bar" },
      { derivedTags: ["lively"], derivedText: "custard tarts" },
    );
    expect(matchesFilter(f, { text: "back bar" })).toBe(true);
    expect(matchesFilter(f, { text: "lively" })).toBe(true);
    expect(matchesFilter(f, { text: "custard" })).toBe(true);
  });

  it("keeps own tags and derived tags as separate facets", () => {
    const f = facets({ tags: ["wine"] }, { derivedTags: ["lively"] });
    expect(matchesFilter(f, { tags: ["wine"] })).toBe(true);
    expect(matchesFilter(f, { tags: ["lively"] })).toBe(false);
    expect(matchesFilter(f, { derivedTags: ["lively"] })).toBe(true);
    expect(matchesFilter(f, { derivedTags: ["wine"] })).toBe(false);
  });

  it("requires every own tag, any one list, a minimum rating and the status", () => {
    const f = facets(
      { tags: ["wine", "date night"], rating: 2, status: "been" },
      { listIds: ["l1"] },
    );
    expect(matchesFilter(f, { tags: ["wine", "date night"] })).toBe(true);
    expect(matchesFilter(f, { tags: ["wine", "brunch"] })).toBe(false);
    expect(matchesFilter(f, { listIds: ["l2", "l1"] })).toBe(true);
    expect(matchesFilter(f, { listIds: ["l2"] })).toBe(false);
    expect(matchesFilter(f, { minRating: 2 })).toBe(true);
    expect(matchesFilter(f, { minRating: 3 })).toBe(false);
    expect(matchesFilter(f, { status: "want" })).toBe(false);
  });

  it("unlisted matches only places on no list", () => {
    expect(matchesFilter(facets(), { unlisted: true })).toBe(true);
    expect(matchesFilter(facets({}, { listIds: ["l1"] }), { unlisted: true })).toBe(false);
  });

  it("an unrated place fails any minimum rating", () => {
    expect(matchesFilter(facets(), { minRating: 1 })).toBe(false);
  });
});

describe("filter shape", () => {
  it("knows the empty filter and compacts facets deterministically", () => {
    expect(isEmptyFilter({ text: "  ", tags: [] })).toBe(true);
    expect(isEmptyFilter({ unlisted: true })).toBe(false);
    expect(
      compactFilter({ text: " wine ", tags: ["B", "a"], listIds: [], unlisted: false }),
    ).toEqual({
      text: "wine",
      tags: ["a", "b"],
    });
  });
});

describe("fact display", () => {
  it("turns raw provider values into readable labels", () => {
    expect(prettyFact("bar_and_grill")).toBe("Bar and grill");
    expect(prettyFact("Coffee_shop;Australian")).toBe("Coffee shop · Australian");
  });

  it("joins category and cuisine without repeating a value", () => {
    expect(placeKindLine({ category: "Coffee_shop;Australian", cuisine: "australian" })).toBe(
      "Coffee shop · Australian",
    );
    expect(placeKindLine({})).toBe("");
  });
});
