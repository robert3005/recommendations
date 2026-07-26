/**
 * Share-service contract (spec/src/sharing.md §Share service): atomic slug
 * claims, bearer-hash auth with constant-time compare, If-Match conditional
 * mutations, idempotent retries, tombstoned slugs, limits, and cache headers.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43); // shaped like 256 bits of base64url
const OTHER_TOKEN = "b".repeat(43);

function guide(title = "Lisbon weekend"): SharedGuide {
  return { v: 1, kind: "list", title, blocks: [], contentHash: "hash" };
}

function harness() {
  const storage = new MemoryStorage();
  const app = createShareApp({ storage, now: () => "2026-07-19T15:00:00.000Z" });
  const request = (path: string, init?: RequestInit) =>
    app.request(`https://share.test${path}`, init);
  const create = (slug: string, token = TOKEN, idKey = `create-${slug}`) =>
    request("/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: slug, document: guide() }),
    });
  return { storage, app, request, create };
}

describe("share service", () => {
  it("claims a slug once, replays the create idempotently, and 409s a second owner", async () => {
    const { request, create } = harness();
    const first = await create("lisbon-trip");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ slug: "lisbon-trip", revision: 1 });
    expect(first.headers.get("cache-control")).toBe("no-store");

    // The same job id replays the original result — a retry, not a conflict.
    const replay = await create("lisbon-trip");
    expect(replay.status).toBe(201);

    // A different creation attempt on the taken slug fails.
    const rival = await request("/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OTHER_TOKEN}`,
        "idempotency-key": "rival-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "lisbon-trip", document: guide() }),
    });
    expect(rival.status).toBe(409);
  });

  it("serves public reads with ETag, cache bounds, and noindex; 304 on If-None-Match", async () => {
    const { request, create } = harness();
    await create("lisbon-trip");
    const read = await request("/s/lists/lisbon-trip");
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe('"1"');
    expect(read.headers.get("x-robots-tag")).toBe("noindex");
    expect(read.headers.get("cache-control")).toContain("max-age=60");
    expect(((await read.json()) as SharedGuide).title).toBe("Lisbon weekend");

    const conditional = await request("/s/lists/lisbon-trip", {
      headers: { "if-none-match": '"1"' },
    });
    expect(conditional.status).toBe(304);
  });

  it("updates only with the right token AND matching revision", async () => {
    const { request, create } = harness();
    await create("lisbon-trip");

    const put = (token: string, ifMatch: string, idKey: string) =>
      request("/s/lists/lisbon-trip", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "if-match": ifMatch,
          "idempotency-key": idKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ document: guide("Updated title") }),
      });

    expect((await put(OTHER_TOKEN, '"1"', "u1")).status).toBe(403);
    expect((await put(TOKEN, '"9"', "u2")).status).toBe(412);
    const ok = await put(TOKEN, '"1"', "u3");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ slug: "lisbon-trip", revision: 2 });
    // An out-of-order retry of an older job can never roll the document back.
    expect((await put(TOKEN, '"1"', "u4")).status).toBe(412);

    const read = await request("/s/lists/lisbon-trip");
    expect(((await read.json()) as SharedGuide).title).toBe("Updated title");
  });

  it("revokes into a non-readable, non-reusable tombstone; replaying the DELETE succeeds", async () => {
    const { request, create } = harness();
    await create("lisbon-trip");
    const del = () =>
      request("/s/lists/lisbon-trip", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "if-match": '"1"',
          "idempotency-key": "revoke-1",
        },
      });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(204); // idempotent replay
    expect((await request("/s/lists/lisbon-trip")).status).toBe(404);
    // The slug is reserved forever — a new owner cannot claim it.
    const reclaim = await request("/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OTHER_TOKEN}`,
        "idempotency-key": "reclaim-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "lisbon-trip", document: guide() }),
    });
    expect(reclaim.status).toBe(409);
  });

  it("rejects reserved slugs, schema-invalid documents, and missing auth/idempotency", async () => {
    const { request } = harness();
    const post = (body: unknown, headers: Record<string, string>) =>
      request("/s/lists", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    expect(
      (
        await post(
          { desiredSlug: "settings", document: guide() },
          { authorization: `Bearer ${TOKEN}`, "idempotency-key": "r1" },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          { desiredSlug: "ok-slug", document: { v: 99 } },
          { authorization: `Bearer ${TOKEN}`, "idempotency-key": "r2" },
        )
      ).status,
    ).toBe(400);
    expect(
      (await post({ desiredSlug: "ok-slug", document: guide() }, { "idempotency-key": "r3" }))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          { desiredSlug: "ok-slug", document: guide() },
          { authorization: `Bearer ${TOKEN}` },
        )
      ).status,
    ).toBe(400);
  });

  it("rate-limits mutations per token", async () => {
    const { create } = harness();
    let limited = false;
    for (let i = 0; i < 40; i += 1) {
      const response = await create(`slug-number-${i.toString()}`, TOKEN, `k${i.toString()}`);
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("stores only the token hash and audits denied attempts", async () => {
    const { storage, create, request } = harness();
    await create("lisbon-trip");
    const doc = await storage.get("list", "lisbon-trip");
    expect(doc?.tokenHash).toHaveLength(64);
    expect(doc?.tokenHash).not.toContain(TOKEN);

    await request("/s/lists/lisbon-trip", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${OTHER_TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "d1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: guide() }),
    });
    expect(storage.auditEntries.some((entry) => entry.action === "denied")).toBe(true);
  });
});
