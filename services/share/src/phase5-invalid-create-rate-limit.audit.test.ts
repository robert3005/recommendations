/** Creation abuse limits must apply before parsing attacker-controlled documents. */
import { LIMITS } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

describe("Phase 5 invalid creation rate limiting", () => {
  it("rate-limits repeated malformed POST attempts from one source", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    const statuses: number[] = [];

    for (let attempt = 0; attempt <= LIMITS.mutationsPerMinute; attempt += 1) {
      const response = await app.request("https://share.test/s/lists", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "idempotency-key": `malformed-create-${attempt.toString()}`,
          "cf-connecting-ip": "203.0.113.40",
          "content-type": "application/json",
        },
        body: "{malformed-json",
      });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  });
});
