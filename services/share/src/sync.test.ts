/**
 * Sync service contract (spec/src/sync.md §The service): a library is claimed
 * by its first authorised request and answers only to that token afterwards;
 * rows are opaque; every write is numbered; nothing is public.
 */
import { SYNC_LIMITS } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);
const OTHER_TOKEN = "b".repeat(43);
const LIB = "c".repeat(32);
const row = (k: string, c = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=") => ({ k: k.repeat(64), c });

function harness() {
  const storage = new MemoryStorage();
  const app = createShareApp({ storage, now: () => "2026-11-23T10:00:00.000Z" });
  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    app.request(`https://share.test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { storage, app, call };
}

describe("sync service", () => {
  it("the first PUT claims the library; the same token confirms it; another is refused", async () => {
    const { call } = harness();
    expect((await call("PUT", `/y/${LIB}`)).status).toBe(201);
    expect((await call("PUT", `/y/${LIB}`)).status).toBe(200);
    expect((await call("PUT", `/y/${LIB}`, undefined, OTHER_TOKEN)).status).toBe(403);
  });

  it("nothing is readable without the library's token", async () => {
    const { call } = harness();
    await call("PUT", `/y/${LIB}`);
    await call("POST", `/y/${LIB}/rows`, { rows: [row("1")] });
    expect((await call("GET", `/y/${LIB}/changes`, undefined, null)).status).toBe(401);
    expect((await call("GET", `/y/${LIB}/changes`, undefined, OTHER_TOKEN)).status).toBe(403);
    expect((await call("POST", `/y/${LIB}/rows`, { rows: [row("2")] }, OTHER_TOKEN)).status).toBe(
      403,
    );
  });

  it("pushes are numbered and a pull returns everything after a cursor", async () => {
    const { call } = harness();
    await call("PUT", `/y/${LIB}`);
    const first = await call("POST", `/y/${LIB}/rows`, { rows: [row("1"), row("2")] });
    expect(await first.json()).toEqual({ cursor: 2 });
    await call("POST", `/y/${LIB}/rows`, { rows: [row("1", "bmV3ZXIgY2lwaGVydGV4dCBoZXJl")] });

    const all = (await (await call("GET", `/y/${LIB}/changes?since=0`)).json()) as {
      rows: { k: string; seq: number }[];
      cursor: number;
      more: boolean;
    };
    // Row 1 was rewritten: it appears once, at its new position.
    expect(all.rows.map((r) => [r.k[0], r.seq])).toEqual([
      ["2", 2],
      ["1", 3],
    ]);
    expect(all).toMatchObject({ cursor: 3, more: false });

    const none = (await (await call("GET", `/y/${LIB}/changes?since=3`)).json()) as {
      rows: unknown[];
      cursor: number;
    };
    expect(none).toMatchObject({ rows: [], cursor: 3 });
  });

  it("pages a large pull and says when more remains", async () => {
    const { call, storage } = harness();
    await call("PUT", `/y/${LIB}`);
    const many = Array.from({ length: SYNC_LIMITS.rowsPerPull + 5 }, (_, i) => ({
      k: i.toString(16).padStart(64, "0"),
      c: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    }));
    await storage.putRows(LIB, many);
    const page = (await (await call("GET", `/y/${LIB}/changes`)).json()) as {
      rows: unknown[];
      cursor: number;
      more: boolean;
    };
    expect(page.rows).toHaveLength(SYNC_LIMITS.rowsPerPull);
    expect(page).toMatchObject({ cursor: SYNC_LIMITS.rowsPerPull, more: true });
  });

  it("refuses malformed input before storing anything", async () => {
    const { call, storage } = harness();
    await call("PUT", `/y/${LIB}`);
    expect((await call("PUT", "/y/not-a-library")).status).toBe(400);
    expect((await call("POST", `/y/${LIB}/rows`, { rows: [] })).status).toBe(400);
    expect(
      (await call("POST", `/y/${LIB}/rows`, { rows: [{ k: "places:1", c: "x" }] })).status,
    ).toBe(400);
    expect((await call("GET", `/y/${LIB}/changes?since=abc`)).status).toBe(400);
    expect(await storage.countRows(LIB)).toBe(0);
  });

  it("a library that was never claimed does not exist for reads or writes", async () => {
    const { call } = harness();
    expect((await call("GET", `/y/${LIB}/changes`)).status).toBe(404);
    expect((await call("POST", `/y/${LIB}/rows`, { rows: [row("1")] })).status).toBe(404);
  });

  it("DELETE removes the library and its rows, and repeats as 204", async () => {
    const { call, storage } = harness();
    await call("PUT", `/y/${LIB}`);
    await call("POST", `/y/${LIB}/rows`, { rows: [row("1")] });
    expect((await call("DELETE", `/y/${LIB}`, undefined, OTHER_TOKEN)).status).toBe(403);
    expect((await call("DELETE", `/y/${LIB}`)).status).toBe(204);
    expect(await storage.countRows(LIB)).toBe(0);
    expect((await call("DELETE", `/y/${LIB}`)).status).toBe(204);
    // The id is free again — whoever holds the key may start over.
    expect((await call("PUT", `/y/${LIB}`)).status).toBe(201);
  });

  it("never caches, and grants CORS to a separately hosted client", async () => {
    const { call } = harness();
    const response = await call("PUT", `/y/${LIB}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await call("OPTIONS", `/y/${LIB}/rows`, undefined, null);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
