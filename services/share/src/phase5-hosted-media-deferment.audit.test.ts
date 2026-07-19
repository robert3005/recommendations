/** Phase 5's deferred hosted-media boundary must cover every document mutation. */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

const guide = (overrides: Partial<SharedGuide> = {}): SharedGuide => ({
  v: 1,
  title: "Media-free publication",
  blocks: [],
  contentHash: "v1",
  ...overrides,
});

describe("Phase 5 hosted-media deferment", () => {
  it("rejects a hosted media claim added by PUT while the media service is deferred", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    const create = await app.request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "idempotency-key": "media-free-create",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "media-free-guide", document: guide() }),
    });
    expect(create.status).toBe(201);

    const update = await app.request("https://share.test/s/lists/media-free-guide", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "unissued-media-update",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        document: guide({
          contentHash: "v2",
          cover: { hostedMediaId: "not-issued-by-the-media-service" },
        }),
      }),
    });

    expect(update.status).toBe(422);
    const stillPublished = await app.request("https://share.test/s/lists/media-free-guide");
    expect(stillPublished.headers.get("etag")).toBe('"1"');
    expect((await stillPublished.json()) as SharedGuide).not.toHaveProperty("cover");
  });
});
