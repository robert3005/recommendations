import { describe, expect, it } from "vitest";
import type { Place, SavedView } from "./entities";
import {
  formatStars,
  isStars,
  upgradeFilterStars,
  upgradePlaceStars,
  upgradeViewStars,
} from "./stars";

const place = (extra: Record<string, unknown>): Place =>
  ({
    id: "p1",
    name: "Brat",
    lat: 51.5,
    lng: -0.07,
    origin: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  }) as unknown as Place;

describe("stars", () => {
  it("takes half steps from 0.5 to 5", () => {
    expect([0.5, 1, 3.5, 5].every(isStars)).toBe(true);
    expect([0, 0.25, 5.5, 3.3, Number.NaN, "4"].some(isStars)).toBe(false);
    expect(formatStars(4)).toBe("4");
    expect(formatStars(3.5)).toBe("3.5");
  });

  it("maps good, great and favourite to 3, 4 and 5 stars", () => {
    expect(upgradePlaceStars(place({ rating: 1 })).stars).toBe(3);
    expect(upgradePlaceStars(place({ rating: 2 })).stars).toBe(4);
    const fav = upgradePlaceStars(place({ rating: 3 }));
    expect(fav.stars).toBe(5);
    expect(fav).not.toHaveProperty("rating");
  });

  it("keeps stars already set, drops off-scale values, and leaves current rows alone", () => {
    expect(upgradePlaceStars(place({ rating: 1, stars: 4.5 })).stars).toBe(4.5);
    expect(upgradePlaceStars(place({ stars: 7 }))).not.toHaveProperty("stars");
    const current = place({ stars: 2.5 });
    expect(upgradePlaceStars(current)).toBe(current);
  });

  it("upgrades a saved view's minimum rating", () => {
    expect(upgradeFilterStars({ minRating: 2 } as never)).toEqual({ minStars: 4 });
    const view = {
      id: "v",
      name: "Best",
      marker: { shape: "star", color: "#000" },
      filter: { tags: ["wine"], minRating: 3 },
      createdAt: "",
      updatedAt: "",
    } as unknown as SavedView;
    expect(upgradeViewStars(view).filter).toEqual({ tags: ["wine"], minStars: 5 });
    const fresh = { ...view, filter: { minStars: 3.5 } };
    expect(upgradeViewStars(fresh)).toBe(fresh);
  });
});
