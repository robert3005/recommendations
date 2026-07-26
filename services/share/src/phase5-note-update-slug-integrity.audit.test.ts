/** A standalone note document must continue to name its public URL after updates. */
import type { SharedNote } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

function note(slug: string, body = "Original body"): SharedNote {
  return {
    v: 1,
    slug,
    context: { kind: "list", listTitle: "Lisbon" },
    body,
    contentHash: body,
    publishedAt: "2026-07-19T15:00:00.000Z",
  };
}

describe("Phase 5 note update slug integrity", () => {
  it("rejects a PUT whose document slug disagrees with the route slug", async () => {
    const app = createShareApp({ storage: new MemoryStorage() });
    const request = (path: string, init?: RequestInit) =>
      app.request(`https://share.test${path}`, init);

    expect(
      (
        await request("/s/notes", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "idempotency-key": "note-slug-create",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            desiredSlug: "canonical-note",
            document: note("canonical-note"),
          }),
        })
      ).status,
    ).toBe(201);

    const update = await request("/s/notes/canonical-note", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "note-slug-update",
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: note("different-public-address", "Changed body") }),
    });

    expect(update.status).toBe(400);
    const published = await request("/s/notes/canonical-note");
    expect(published.headers.get("etag")).toBe('"1"');
    expect((await published.json()) as SharedNote).toMatchObject({
      slug: "canonical-note",
      body: "Original body",
    });
  });
});
