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
    VITE_PHOTON_URL: "https://photon.komoot.io",
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
