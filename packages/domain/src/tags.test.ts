import { describe, expect, it } from "vitest";
import { normalizeTagName } from "./tags";

describe("normalizeTagName", () => {
  it("normalizes case and whitespace, preserving nothing but identity", () => {
    expect(normalizeTagName("  Date  Night ")).toBe("date night");
    expect(normalizeTagName("COFFEE")).toBe("coffee");
  });
  it("applies unicode NFKC so visually identical tags collide", () => {
    expect(normalizeTagName("café")).toBe(normalizeTagName("café"));
  });
});
