/** Concurrent retries of one mutation job must converge on one successful result. */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

function guide(title: string, contentHash = title): SharedGuide {
  return { v: 1, kind: "list", title, blocks: [], contentHash };
}

async function createGuide(app: ReturnType<typeof createShareApp>, slug: string) {
  return app.request("https://share.test/s/lists", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "idempotency-key": `create-${slug}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ desiredSlug: slug, document: guide("Original", "v1") }),
  });
}

describe("Phase 5 concurrent mutation idempotency", () => {
  it("returns the same success to concurrent retries of one PUT job", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    expect((await createGuide(app, "concurrent-update")).status).toBe(201);
    const update = () =>
      app.request("https://share.test/s/lists/concurrent-update", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "if-match": '"1"',
          "idempotency-key": "one-concurrent-update-job",
          "content-type": "application/json",
        },
        body: JSON.stringify({ document: guide("Updated once", "v2") }),
      });

    const responses = await Promise.all([update(), update()]);

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(await responses[0]?.text()).toBe(await responses[1]?.text());
    const published = await app.request("https://share.test/s/lists/concurrent-update");
    expect(published.headers.get("etag")).toBe('"2"');
  });

  it("returns success to concurrent retries of one DELETE job", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    expect((await createGuide(app, "concurrent-revoke")).status).toBe(201);
    const revoke = () =>
      app.request("https://share.test/s/lists/concurrent-revoke", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "if-match": '"1"',
          "idempotency-key": "one-concurrent-revoke-job",
        },
      });

    const responses = await Promise.all([revoke(), revoke()]);

    expect(responses.map(({ status }) => status)).toEqual([204, 204]);
    expect((await app.request("https://share.test/s/lists/concurrent-revoke")).status).toBe(404);
  });
});
