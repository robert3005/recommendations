/**
 * Share-service contract (spec/src/sharing.md §The share service): PUT is
 * create-or-update under a Bearer editor token (201 claim / 200 update / 403
 * foreign / 410 tombstoned), GET is public with ETag + shared-cache headers,
 * DELETE tombstones idempotently. No accounts, no If-Match, no idempotency
 * keys — retrying means sending the same request again.
 */
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43); // shaped like 256 bits of base64url
const OTHER_TOKEN = "b".repeat(43);

function listDoc(title = "Lisbon weekend") {
  return {
    v: 1,
    kind: "list",
    title,
    marker: { shape: "circle", color: "#F97316" },
    places: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Café A Brasileira",
        lat: 38.7107,
        lng: -9.1421,
        address: "R. Garrett 122, Lisboa",
        category: "cafe",
        osmRef: { type: "node", id: "3775257522" },
      },
    ],
  };
}

function postDoc(title = "A Lisbon walk") {
  return {
    v: 1,
    kind: "post",
    title,
    body: "Start at [Brasileira](#place-11111111-1111-4111-8111-111111111111).",
    places: listDoc().places,
    list: { title: "Lisbon weekend" },
  };
}

function harness() {
  const storage = new MemoryStorage();
  const app = createShareApp({ storage, now: () => "2026-07-26T15:00:00.000Z" });
  const request = (path: string, init?: RequestInit) =>
    app.request(`https://share.test${path}`, init);
  const put = (slug: string, doc: unknown = listDoc(), token = TOKEN, collection = "lists") =>
    request(`/s/${collection}/${slug}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
  return { storage, app, request, put };
}

describe("share service", () => {
  it("claims a slug with the first PUT and replaces the document with the same token", async () => {
    const { request, put } = harness();
    const created = await put("lisbon-trip");
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ slug: "lisbon-trip" });
    expect(created.headers.get("cache-control")).toBe("no-store");

    const updated = await put("lisbon-trip", listDoc("Lisbon, updated"));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ slug: "lisbon-trip" });

    const read = await request("/s/lists/lisbon-trip");
    expect(read.status).toBe(200);
    expect(((await read.json()) as { title: string }).title).toBe("Lisbon, updated");
  });

  it("refuses a foreign token with 403 and leaves the document untouched", async () => {
    const { request, put } = harness();
    await put("lisbon-trip");
    const rival = await put("lisbon-trip", listDoc("Hijacked"), OTHER_TOKEN);
    expect(rival.status).toBe(403);
    const read = await request("/s/lists/lisbon-trip");
    expect(((await read.json()) as { title: string }).title).toBe("Lisbon weekend");
  });

  it("serves public reads with ETag, s-maxage, noindex, and CORS; 304 on If-None-Match", async () => {
    const { request, put } = harness();
    await put("lisbon-trip");
    const read = await request("/s/lists/lisbon-trip");
    expect(read.status).toBe(200);
    const etag = read.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/); // hash of the body
    expect(read.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(read.headers.get("x-robots-tag")).toBe("noindex");
    expect(read.headers.get("access-control-allow-origin")).toBe("*");

    const conditional = await request("/s/lists/lisbon-trip", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(conditional.status).toBe(304);

    // An update changes the body, so it changes the ETag.
    await put("lisbon-trip", listDoc("Lisbon, updated"));
    const after = await request("/s/lists/lisbon-trip", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
  });

  it("404s an unknown slug and keeps lists and posts as separate namespaces", async () => {
    const { request, put } = harness();
    expect((await request("/s/lists/never-was")).status).toBe(404);

    expect((await put("walk", postDoc(), TOKEN, "posts")).status).toBe(201);
    expect((await request("/s/posts/walk")).status).toBe(200);
    expect((await request("/s/lists/walk")).status).toBe(404);
  });

  it("tombstones on DELETE: 204, idempotent repeat, 410 reads, 410 PUTs, no reclaim ever", async () => {
    const { request, put } = harness();
    await put("lisbon-trip");
    const del = (token = TOKEN) =>
      request("/s/lists/lisbon-trip", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(204); // idempotent by nature

    expect((await request("/s/lists/lisbon-trip")).status).toBe(410);
    // Neither the owner nor anyone else can write over a tombstone.
    expect((await put("lisbon-trip")).status).toBe(410);
    expect((await put("lisbon-trip", listDoc(), OTHER_TOKEN)).status).toBe(410);
  });

  it("refuses a foreign-token DELETE and a missing token on any mutation", async () => {
    const { request, put } = harness();
    await put("lisbon-trip");
    const foreign = await request("/s/lists/lisbon-trip", {
      method: "DELETE",
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(foreign.status).toBe(403);
    expect((await request("/s/lists/lisbon-trip")).status).toBe(200);

    const bare = (method: string) => request("/s/lists/lisbon-trip", { method });
    expect((await bare("PUT")).status).toBe(401);
    expect((await bare("DELETE")).status).toBe(401);
    expect(
      (
        await request("/s/lists/ghost", {
          method: "DELETE",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
  });

  it("rejects schema-invalid documents, malformed JSON, and reserved or malformed slugs", async () => {
    const { request, put } = harness();
    expect((await put("ok-slug", { v: 99 })).status).toBe(400);
    expect((await put("settings")).status).toBe(400); // reserved
    expect((await put("Not-A-Slug!")).status).toBe(400);
    const malformed = await request("/s/lists/ok-slug", {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("413s an oversized request body", async () => {
    const { request } = harness();
    const oversize = await request("/s/lists/ok-slug", {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "x".repeat(1_048_577),
    });
    expect(oversize.status).toBe(413);
  });

  it("rate-limits mutations per token+source bucket", async () => {
    const { put } = harness();
    let limited = false;
    for (let i = 0; i < 40; i += 1) {
      const response = await put(`slug-number-${i.toString()}`);
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("stores only the token hash, never the token", async () => {
    const { storage, put } = harness();
    await put("lisbon-trip");
    const doc = await storage.get("list", "lisbon-trip");
    expect(doc?.tokenHash).toHaveLength(64);
    expect(doc?.tokenHash).not.toContain(TOKEN);
  });
});
