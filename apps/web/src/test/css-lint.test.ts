import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the application stylesheet passes the configured CSS parser and linter", () => {
  const result = spawnSync("pnpm", ["exec", "biome", "check", "src/index.css"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
});
