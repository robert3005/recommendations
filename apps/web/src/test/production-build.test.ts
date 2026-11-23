import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the production PWA build completes with a precacheable application shell", () => {
  const result = spawnSync("pnpm", ["exec", "vite", "build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      // A production build fails closed without explicit provider configuration.
      // Search needs none: it defaults to Stadia Maps, a contracted provider.
      VITE_MAP_STYLE_URL: "https://tiles.example/style.json",
      VITE_OSM_API_URL: "https://osm.example",
    },
  });

  expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
}, 30_000);
