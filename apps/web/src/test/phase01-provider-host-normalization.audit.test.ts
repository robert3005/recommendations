/** URL host names are case-insensitive. Production fail-closed checks must not
 * let a development provider through merely because its host uses capitals. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("a production build rejects a case-variant development provider host", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-case-demo-provider-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
    VITE_MAP_STYLE_URL: "https://TILES.OPENFREEMAP.ORG/styles/bright",
    VITE_PHOTON_URL: "https://search.production.example",
    VITE_OSM_API_URL: "https://osm.production.example",
    VITE_OVERPASS_URL: "https://poi.production.example/api/interpreter",
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
