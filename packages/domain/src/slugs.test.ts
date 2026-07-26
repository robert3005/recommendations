import { describe, expect, it } from "vitest";
import { slugCandidates, slugFromTitle } from "./slugs";

describe("slugFromTitle", () => {
  it("normalises to lowercase ascii with single hyphens", () => {
    expect(slugFromTitle("A Weekend in Lisbon")).toBe("a-weekend-in-lisbon");
    expect(slugFromTitle("  Coffee & Cake!!  ")).toBe("coffee-cake");
  });

  it("strips diacritics", () => {
    expect(slugFromTitle("Café São João")).toBe("cafe-sao-joao");
  });

  it("never returns an empty slug", () => {
    expect(slugFromTitle("")).toBe("untitled");
    expect(slugFromTitle("!!! — !!!")).toBe("untitled");
    expect(slugFromTitle("北京")).toBe("untitled");
  });

  it("caps length without a trailing hyphen", () => {
    const slug = slugFromTitle(`${"long-word ".repeat(20)}end`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("slugCandidates", () => {
  it("walks the base, then -2 … -9 (spec/src/sharing.md)", () => {
    expect(slugCandidates("lisbon")).toEqual([
      "lisbon",
      "lisbon-2",
      "lisbon-3",
      "lisbon-4",
      "lisbon-5",
      "lisbon-6",
      "lisbon-7",
      "lisbon-8",
      "lisbon-9",
    ]);
  });
});
