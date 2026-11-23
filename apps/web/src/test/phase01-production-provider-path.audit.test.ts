/** Public/demo OSM services are development-only, even if their URLs are copied into env vars. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("a production build rejects the known development/demo provider path", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-demo-provider-build-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
    VITE_MAP_STYLE_URL: "https://tiles.openfreemap.org/styles/bright",
    VITE_OSM_API_URL: "https://api.openstreetmap.org",
  };
  delete env.PLACEMARKS_STORYBOOK;

  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/development|demo|production provider/i);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);

test("a test deployment may look up on the public OSM API, never draw a demo basemap", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-test-deploy-build-"));
  const base: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
    PLACEMARKS_TEST_DEPLOY: "1",
    VITE_MAP_STYLE_URL: "https://tiles.example/style.json",
    VITE_OSM_API_URL: "https://api.openstreetmap.org",
  };
  delete base.PLACEMARKS_STORYBOOK;
  const build = (env: Record<string, string | undefined>) => {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    return { status: result.status, output: [result.stdout, result.stderr].join("\n") };
  };

  try {
    const geocoders = build(base);
    expect(geocoders.status, geocoders.output).toBe(0);

    const basemap = build({
      ...base,
      VITE_MAP_STYLE_URL: "https://tiles.openfreemap.org/styles/bright",
    });
    expect(basemap.status, basemap.output).not.toBe(0);
    expect(basemap.output).toMatch(/VITE_MAP_STYLE_URL/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 60_000);

test("an overriding search endpoint is checked like every other provider URL", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-search-url-build-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
    VITE_MAP_STYLE_URL: "https://tiles.example/style.json",
    VITE_OSM_API_URL: "https://osm.example",
    VITE_STADIA_URL: "https://nominatim.openstreetmap.org",
  };
  delete env.PLACEMARKS_STORYBOOK;

  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/VITE_STADIA_URL/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);
