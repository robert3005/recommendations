import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

/** The self-hosted plate path (spec/src/data-sources.md §Map tiles) is a production basemap. */
function build(extra: Record<string, string>) {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-plate-build-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
    VITE_PHOTON_URL: "https://photon.example",
    VITE_OSM_API_URL: "https://osm.example",
    ...extra,
  };
  delete env.VITE_MAP_STYLE_URL;
  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    return { status: result.status, output: [result.stdout, result.stderr].join("\n") };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test("a PMTiles plate with self-hosted glyphs and sprite builds without a style URL", () => {
  const { status, output } = build({
    VITE_MAP_PMTILES_URL: "https://tiles.example/world.pmtiles",
    VITE_MAP_GLYPHS_URL: "https://tiles.example/fonts/{fontstack}/{range}.pbf",
    VITE_MAP_SPRITE_URL: "https://tiles.example/sprites/light",
  });
  expect(status, output).toBe(0);
}, 60_000);

test("the plate fails closed on the development-only glyph host", () => {
  const { status, output } = build({
    VITE_MAP_PMTILES_URL: "https://tiles.example/world.pmtiles",
    VITE_MAP_GLYPHS_URL:
      "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    VITE_MAP_SPRITE_URL: "https://tiles.example/sprites/light",
  });
  expect(status, output).not.toBe(0);
  expect(output).toMatch(/VITE_MAP_GLYPHS_URL/);
}, 60_000);
