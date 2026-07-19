/** Phase 5 public-cache invalidation contract from book/src/sharing.md. */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

const guide: SharedGuide = {
  v: 1,
  title: "Cache lifecycle",
  blocks: [],
  contentHash: "cache-lifecycle-v1",
};

describe("Phase 5 public cache lifecycle", () => {
  it("gives each public document a stable purgeable surrogate key", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    const request = (path: string, init?: RequestInit) =>
      app.request(`https://share.test${path}`, init);

    const created = await request("/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "idempotency-key": "cache-lifecycle-create",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "cache-lifecycle", document: guide }),
    });
    expect(created.status).toBe(201);

    const first = await request("/s/lists/cache-lifecycle");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toMatch(/max-age/i);

    // The deployment may call this Surrogate-Key (Fastly-style) or Cache-Tag
    // (Cloudflare-style), but the value must identify this publication so an
    // update/revoke can purge every cached representation deterministically.
    const purgeKey =
      first.headers.get("surrogate-key") ??
      first.headers.get("cache-tag") ??
      first.headers.get("cdn-cache-tag");
    expect(purgeKey).toBeTruthy();
    expect(purgeKey).toContain("cache-lifecycle");

    const conditional = await request("/s/lists/cache-lifecycle", {
      headers: { "if-none-match": first.headers.get("etag") ?? "" },
    });
    expect(conditional.status).toBe(304);
    const conditionalPurgeKey =
      conditional.headers.get("surrogate-key") ??
      conditional.headers.get("cache-tag") ??
      conditional.headers.get("cdn-cache-tag");
    expect(conditionalPurgeKey).toBe(purgeKey);
  });
});
