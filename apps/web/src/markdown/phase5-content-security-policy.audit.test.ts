/** The app and every public viewer share one restrictive document-level CSP. */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const webRoot = process.cwd();
const policyCandidates = [
  "index.html",
  "vite.config.ts",
  "public/_headers",
  "public/headers.json",
  "_headers",
  "netlify.toml",
  "vercel.json",
  "wrangler.toml",
  "staticwebapp.config.json",
];

function checkedInPolicySources(): string {
  return policyCandidates
    .map((name) => `${webRoot}/${name}`)
    .filter(existsSync)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function directive(policy: string, name: string): string | undefined {
  return new RegExp(`${name}\\s+([^;\\n<>}]+)`, "i").exec(policy)?.[1]?.trim();
}

function hasOpenWildcard(value: string): boolean {
  return /(?:^|\s)\*(?:\s|$)/.test(value);
}

describe("Markdown/public-viewer Content Security Policy", () => {
  it("declares an effective restrictive policy in the SPA or checked-in host headers", () => {
    const policy = checkedInPolicySources();

    expect(policy).toMatch(/content-security-policy/i);
    const fallback = directive(policy, "default-src");
    expect(fallback).toBeDefined();
    if (!fallback) return;

    // Missing fetch directives inherit default-src, so they need not be
    // repeated. Their effective values still may not be open wildcards.
    for (const name of ["script-src", "img-src", "connect-src"]) {
      expect(hasOpenWildcard(directive(policy, name) ?? fallback)).toBe(false);
    }
    expect(hasOpenWildcard(fallback)).toBe(false);
    expect(directive(policy, "script-src") ?? fallback).not.toMatch(/'unsafe-eval'/i);

    // Plugins/embedded active objects are not part of this app. Whether
    // explicit or inherited, their effective source list must be closed.
    expect(directive(policy, "object-src") ?? fallback).toMatch(/'none'/i);
  });
});
