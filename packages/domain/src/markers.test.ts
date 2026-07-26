import { describe, expect, it } from "vitest";
import type { ListMarker, MarkerShape } from "./entities";
import {
  ACCENT_COLORS,
  assignMarker,
  MARKER_SHAPE_PATHS,
  MARKER_SHAPES,
  markerKey,
  nearestAccent,
} from "./markers";

const ORANGE = "#F97316";
const COBALT = "#2457E6";
const GREEN = "#17A34A";

describe("the palette", () => {
  it("is the spec's eight shapes in order", () => {
    expect(MARKER_SHAPES).toEqual([
      "circle",
      "diamond",
      "triangle",
      "square",
      "hexagon",
      "star",
      "semicircle",
      "chevron",
    ]);
  });

  it("is the spec's eight accents in order, fills and deeps", () => {
    expect(ACCENT_COLORS.map((a) => a.name)).toEqual([
      "orange",
      "cobalt",
      "green",
      "magenta",
      "cyan",
      "gold",
      "vermilion",
      "violet",
    ]);
    expect(ACCENT_COLORS.map((a) => a.fill)).toEqual([
      "#F97316",
      "#2457E6",
      "#17A34A",
      "#D6219C",
      "#08AECE",
      "#F0B100",
      "#E43D1F",
      "#7C3AED",
    ]);
    expect(ACCENT_COLORS.map((a) => a.deep)).toEqual([
      "#B04A08",
      "#1B3EA9",
      "#0E6B33",
      "#96156C",
      "#0E7490",
      "#8A6400",
      "#AC2410",
      "#5B21B6",
    ]);
  });

  it("has one solid closed path per shape", () => {
    for (const shape of MARKER_SHAPES) {
      const path = MARKER_SHAPE_PATHS[shape];
      expect(path.startsWith("M")).toBe(true);
      expect(path.endsWith("Z")).toBe(true);
    }
    expect(Object.keys(MARKER_SHAPE_PATHS)).toHaveLength(8);
  });
});

describe("markerKey", () => {
  it("is shape:colour", () => {
    expect(markerKey({ shape: "circle", color: ORANGE })).toBe(`circle:${ORANGE}`);
  });
});

describe("assignMarker", () => {
  it("assigns the first free pair, and never a badge while pairs remain", () => {
    const { marker, badge } = assignMarker([]);
    expect(marker).toEqual({ shape: "circle", color: ORANGE });
    expect(badge).toBeUndefined();
  });

  it("makes the first eight lists differ in BOTH shape and colour", () => {
    const taken: ListMarker[] = [];
    for (let i = 0; i < 8; i += 1) taken.push(assignMarker(taken).marker);
    expect(new Set(taken.map((m) => m.shape)).size).toBe(8);
    expect(new Set(taken.map((m) => m.color)).size).toBe(8);
  });

  it("walks all 64 pairs before repeating any", () => {
    const taken: ListMarker[] = [];
    for (let i = 0; i < 64; i += 1) {
      const { marker, badge } = assignMarker(taken);
      expect(badge).toBeUndefined();
      taken.push(marker);
    }
    expect(new Set(taken.map(markerKey)).size).toBe(64);
  });

  it("tries the preferred colour's free shapes first", () => {
    const first = assignMarker([], GREEN);
    expect(first.marker).toEqual({ shape: "circle", color: GREEN });
    const second = assignMarker([first.marker], GREEN);
    expect(second.marker).toEqual({ shape: "diamond", color: GREEN });
  });

  it("snaps a source style colour to the nearest accent", () => {
    expect(assignMarker([], "#00FF00").marker.color).toBe(GREEN);
  });

  it("falls back to the general walk when the preferred colour is exhausted", () => {
    const taken = MARKER_SHAPES.map((shape) => ({ shape, color: GREEN }));
    const { marker, badge } = assignMarker(taken, GREEN);
    expect(marker.color).not.toBe(GREEN);
    expect(badge).toBeUndefined();
  });

  it("repeats deterministically with a numeral badge beyond 64 live lists", () => {
    const taken: ListMarker[] = [];
    for (let i = 0; i < 64; i += 1) taken.push(assignMarker(taken).marker);

    const sixtyFifth = assignMarker(taken);
    expect(sixtyFifth.marker).toEqual({ shape: "circle", color: ORANGE });
    expect(sixtyFifth.badge).toBe(2);

    taken.push(sixtyFifth.marker);
    const sixtySixth = assignMarker(taken);
    expect(sixtySixth.marker).toEqual({ shape: "diamond", color: COBALT });
    expect(sixtySixth.badge).toBe(2);
  });
});

describe("nearestAccent", () => {
  it("returns the exact accent for its own fill", () => {
    for (const accent of ACCENT_COLORS) expect(nearestAccent(accent.fill)).toBe(accent);
  });

  it("matches nearby hues, not just exact values", () => {
    expect(nearestAccent("#0000ff").name).toBe("cobalt");
    expect(nearestAccent("#FF0000").name).toBe("vermilion");
    expect(nearestAccent("#0f0").name).toBe("green");
  });

  it("falls back deterministically on unparsable input", () => {
    expect(nearestAccent("not-a-colour")).toBe(ACCENT_COLORS[0]);
  });
});

describe("shape typing", () => {
  it("MARKER_SHAPE_PATHS covers exactly the MarkerShape union", () => {
    const shapes: MarkerShape[] = [...MARKER_SHAPES];
    for (const shape of shapes) expect(MARKER_SHAPE_PATHS[shape]).toBeTypeOf("string");
  });
});
