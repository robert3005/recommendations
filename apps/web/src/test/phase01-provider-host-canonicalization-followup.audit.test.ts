/**
 * Production provider checks operate on a parsed, canonical hostname. Encoded
 * dots cannot hide a demo host, while a demo-looking path or longer unrelated
 * hostname must not be rejected by substring matching.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function productionBuild(mapStyleUrl: string): { status: number | null; output: string } {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-canonical-provider-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
    VITE_MAP_STYLE_URL: mapStyleUrl,
    VITE_PHOTON_URL: "https://search.production.example",
    VITE_OSM_API_URL: "https://osm.production.example",
  };
  delete env.PLACEMARKS_STORYBOOK;

  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    return {
      status: result.status,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe("Phase 0 production provider hostname canonicalization", () => {
  test("rejects a demo hostname whose dots are URL-encoded", () => {
    const result = productionBuild("https://tiles%2eopenfreemap%2eorg/styles/bright");

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/development|demo|production provider/i);
  }, 30_000);

  test.each([
    {
      label: "a malformed production provider URL",
      url: "not-a-provider-url",
    },
    {
      label: "a trailing-dot spelling of a demo hostname",
      url: "https://tiles.openfreemap.org./styles/bright",
    },
  ])(
    "rejects $label",
    ({ url }) => {
      const result = productionBuild(url);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(
        /configuration|development|demo|invalid|production provider|url/i,
      );
    },
    30_000,
  );

  test.each([
    {
      label: "a longer unrelated hostname",
      url: "https://tiles.openfreemap.org.production.example/styles/bright",
    },
    {
      label: "a production-hosted proxy path",
      url: "https://tiles.production.example/proxy/tiles.openfreemap.org/styles/bright",
    },
  ])(
    "allows $label containing demo-host text outside the actual hostname",
    ({ url }) => {
      const result = productionBuild(url);

      expect(result.status, result.output).toBe(0);
    },
    30_000,
  );
});
