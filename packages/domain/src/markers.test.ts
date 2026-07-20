import { describe, expect, it } from "vitest";
import {
  completeMarker,
  MARKER_COLORS,
  MARKER_ICONS,
  markerAt,
  markerKey,
  nextUnusedMarker,
} from "./markers";

describe("marker enumeration", () => {
  it("yields every (colour, icon) combination exactly once before wrapping", () => {
    const total = MARKER_COLORS.length * MARKER_ICONS.length;
    const seen = new Set<string>();
    for (let k = 0; k < total; k += 1) {
      seen.add(markerKey(markerAt(k)));
    }
    expect(seen.size).toBe(total);
  });

  it("varies both colour and icon across the first assignments", () => {
    const first = Array.from({ length: MARKER_COLORS.length }, (_, k) => markerAt(k));
    expect(new Set(first.map((m) => m.color)).size).toBe(MARKER_COLORS.length);
    expect(new Set(first.map((m) => m.icon)).size).toBeGreaterThan(1);
  });
});

describe("nextUnusedMarker", () => {
  it("assigns the first combination to the first list", () => {
    expect(nextUnusedMarker([])).toEqual(markerAt(0));
  });

  it("skips used combinations", () => {
    const used = [markerAt(0), markerAt(1)];
    expect(nextUnusedMarker(used)).toEqual(markerAt(2));
  });

  it("fills gaps left by deleted or re-marked lists", () => {
    const used = [markerAt(0), markerAt(2)];
    expect(nextUnusedMarker(used)).toEqual(markerAt(1));
  });
});

describe("completeMarker (colour-only migration, KML import)", () => {
  it("keeps a known colour and picks an icon keeping the pair unique", () => {
    const color = MARKER_COLORS[3] as string;
    const existing = [{ color, icon: MARKER_ICONS[0] as string }];
    const completed = completeMarker({ color }, existing);
    expect(completed.color).toBe(color);
    expect(completed.icon).not.toBe(MARKER_ICONS[0]);
  });

  it("keeps an already-unique full pair", () => {
    const marker = { color: MARKER_COLORS[1] as string, icon: MARKER_ICONS[4] as string };
    expect(completeMarker(marker, [])).toEqual(marker);
  });

  it("assigns the next unused combination when nothing is known", () => {
    expect(completeMarker({}, [markerAt(0)])).toEqual(markerAt(1));
  });

  it("moves off a taken pair while preserving the colour", () => {
    const color = MARKER_COLORS[0] as string;
    const existing = MARKER_ICONS.slice(0, 3).map((icon) => ({ color, icon }));
    const completed = completeMarker({ color, icon: MARKER_ICONS[1] as string }, existing);
    expect(completed.color).toBe(color);
    expect(existing.some((m) => m.icon === completed.icon)).toBe(false);
  });
});
