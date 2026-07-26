/** Malformed authorized updates are still mutation attempts and must consume abuse quota. */
import type { SharedGuide } from "@placemarks/schemas";
import { LIMITS } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

describe("Phase 5 invalid update rate limiting", () => {
  it("rate-limits repeated malformed PUT attempts from an authorized editor", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    const document: SharedGuide = {
      v: 1,
      kind: "list",
      title: "Rate-limited guide",
      blocks: [],
      contentHash: "v1",
    };
    const created = await app.request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "idempotency-key": "create-rate-limited-guide",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "rate-limited-guide", document }),
    });
    expect(created.status).toBe(201);

    const statuses: number[] = [];
    for (let attempt = 0; attempt <= LIMITS.mutationsPerMinute; attempt += 1) {
      const response = await app.request("https://share.test/s/lists/rate-limited-guide", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "cf-connecting-ip": "203.0.113.41",
          "if-match": '"1"',
          "idempotency-key": `malformed-update-${attempt.toString()}`,
          "content-type": "application/json",
        },
        body: "{malformed-json",
      });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  });
});
