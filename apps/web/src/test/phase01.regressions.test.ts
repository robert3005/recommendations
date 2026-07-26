import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("a production build fails closed when required provider configuration is absent", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-phase01-build-"));
  // Typed loosely: vite's ambient `process.env` typing has no index signature.
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "production" };
  for (const key of [
    "VITE_MAP_STYLE_URL",
    "VITE_PHOTON_URL",
    "VITE_OSM_API_URL",
    "VITE_ENABLE_MSW",
    "PLACEMARKS_STORYBOOK",
  ]) {
    delete env[key];
  }

  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/provider|VITE_/i);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);

test("the Storybook static build does not require production provider credentials", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-phase01-storybook-"));
  const env = { ...process.env };
  for (const key of [
    "VITE_MAP_STYLE_URL",
    "VITE_PHOTON_URL",
    "VITE_OSM_API_URL",
    "PLACEMARKS_STORYBOOK",
  ]) {
    delete env[key];
  }

  try {
    const result = spawnSync("pnpm", ["exec", "storybook", "build", "--output-dir", outDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

    expect(result.status, output).toBe(0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);
