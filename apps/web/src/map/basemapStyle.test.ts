import { describe, expect, it } from "vitest";
import { plateFlavor, plateStyle } from "./basemapStyle";

const style = plateStyle({
  pmtilesUrl: "https://tiles.example/world.pmtiles",
  glyphsUrl: "https://tiles.example/fonts/{fontstack}/{range}.pbf",
  spriteUrl: "https://tiles.example/sprites/light",
  attribution: "Protomaps",
});

describe("basemap plate", () => {
  it("reads one PMTiles archive through the pmtiles protocol", () => {
    expect(style.sources.protomaps).toMatchObject({
      type: "vector",
      url: "pmtiles://https://tiles.example/world.pmtiles",
    });
  });

  it("drops POI icons and road shields so only the user's pins mark places", () => {
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).not.toContain("pois");
    expect(ids).not.toContain("roads_shields");
    expect(ids.length).toBeGreaterThan(40);
  });

  it("keeps the plate neutral: every colour is a near-grey", () => {
    const flavor = plateFlavor();
    const colours = Object.entries(flavor)
      .filter(
        ([key, value]) => typeof value === "string" && !["regular", "bold", "italic"].includes(key),
      )
      .map(([, value]) => value as string);
    for (const hex of colours) {
      const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      // Low chroma: no channel strays far from the others.
      expect(Math.max(...channels) - Math.min(...channels), hex).toBeLessThanOrEqual(40);
    }
  });
});
