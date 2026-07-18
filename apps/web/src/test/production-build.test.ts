import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the production PWA build completes with a precacheable application shell", () => {
  const result = spawnSync("pnpm", ["exec", "vite", "build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });

  expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
}, 30_000);
