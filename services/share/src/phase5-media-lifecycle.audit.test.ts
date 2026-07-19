/** Phase 5 hosted-media ownership boundary from book/src/notes.md. */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

describe("Phase 5 hosted media lifecycle", () => {
  it("rejects a hosted media id that is not bound to the publication and editor token", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    const document: SharedGuide = {
      v: 1,
      title: "Media boundary",
      cover: { hostedMediaId: "med_owned_by_someone_else" },
      blocks: [],
      contentHash: "hash",
    };

    const response = await app.request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "idempotency-key": "unbound-media",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "media-boundary", document }),
    });

    expect([400, 403, 422]).toContain(response.status);
  });
});
