/** Hosted-media deferment must inspect the parsed document, not raw JSON spelling. */
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

describe("Phase 5 structural hosted-media validation", () => {
  it("rejects a hostedMediaId whose JSON key uses an equivalent Unicode escape", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    const raw =
      '{"desiredSlug":"escaped-media","document":{"v":1,"title":"Escaped media",' +
      '"cover":{"hostedMedia\\u0049d":"not-issued-by-the-media-service"},' +
      '"blocks":[],"contentHash":"v1"}}';

    // JSON decoding turns the escaped key into the forbidden hostedMediaId.
    expect(JSON.parse(raw).document.cover).toHaveProperty("hostedMediaId");

    const response = await app.request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "idempotency-key": "escaped-hosted-media-create",
        "content-type": "application/json",
      },
      body: raw,
    });

    expect(response.status).toBe(422);
    expect((await app.request("https://share.test/s/lists/escaped-media")).status).toBe(404);
  });
});
