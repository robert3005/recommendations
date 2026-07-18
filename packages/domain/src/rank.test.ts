import { describe, expect, it } from "vitest";
import { compareByRank } from "./entities";
import { rankAfter, rankBetween, ranksBetween } from "./rank";

describe("fractional ranks", () => {
  it("orders between neighbors", () => {
    const a = rankBetween(null, null);
    const c = rankAfter(a);
    const b = rankBetween(a, c);
    expect(a < b && b < c).toBe(true);
  });

  it("supports repeated in-between insertion", () => {
    let low = rankBetween(null, null);
    const high = rankAfter(low);
    for (let i = 0; i < 50; i++) {
      const mid = rankBetween(low, high);
      expect(low < mid && mid < high).toBe(true);
      low = mid;
    }
  });

  it("generates n sorted keys", () => {
    const keys = ranksBetween(null, null, 10);
    expect([...keys].sort()).toEqual(keys);
  });

  it("compareByRank breaks ties deterministically by id", () => {
    const blocks = [
      { rank: "a0", id: "b" },
      { rank: "a0", id: "a" },
      { rank: "Zz", id: "c" },
    ];
    expect(blocks.sort(compareByRank).map((b) => b.id)).toEqual(["c", "a", "b"]);
  });
});
