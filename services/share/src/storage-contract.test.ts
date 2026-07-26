/**
 * One contract, run against BOTH `ShareStorage` adapters: the memory adapter
 * and the D1 adapter must agree on the semantics the service depends on —
 * atomic slug claim, live-row-only update, idempotent tombstone, fixed-window
 * counters — so those are stated once, here.
 */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";
import { MemoryStorage, type ShareStorage, type StoredDocument } from "./storage";

const NOW = "2026-07-26T12:00:00.000Z";
const LATER = "2026-07-26T13:00:00.000Z";

function doc(overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    kind: "list",
    slug: "lisbon-eats",
    tokenHash: "a".repeat(64),
    body: '{"v":1}',
    revokedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A SQLite-shaped fake: enough of D1 to exercise the adapter's real SQL through
 * the same code path the Worker uses, without pinning statement text.
 */
function fakeD1(): D1Like {
  const documents = new Map<string, Record<string, unknown>>();
  const rate = new Map<string, { count: number; reset_at: string }>();
  const key = (kind: unknown, slug: unknown) => `${String(kind)}:${String(slug)}`;

  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async run() {
          if (/^INSERT INTO documents/i.test(sql)) {
            const [kind, slug, token_hash, body, updated_at] = bound;
            const id = key(kind, slug);
            if (documents.has(id)) {
              throw new Error("UNIQUE constraint failed: documents.kind, documents.slug");
            }
            documents.set(id, { kind, slug, token_hash, body, revoked_at: null, updated_at });
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE documents SET revoked_at/i.test(sql)) {
            const [revokedAt, kind, slug] = bound;
            const row = documents.get(key(kind, slug));
            if (!row || row.revoked_at !== null) return { meta: { changes: 0 } };
            Object.assign(row, { revoked_at: revokedAt, body: "", updated_at: revokedAt });
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE documents SET body/i.test(sql)) {
            const [body, updatedAt, kind, slug] = bound;
            const row = documents.get(key(kind, slug));
            if (!row || row.revoked_at !== null) return { meta: { changes: 0 } };
            Object.assign(row, { body, updated_at: updatedAt });
            return { meta: { changes: 1 } };
          }
          if (/^INSERT INTO rate/i.test(sql)) {
            const [bucket, resetAt, now] = bound as [string, string, string];
            const current = rate.get(bucket);
            rate.set(
              bucket,
              current && current.reset_at > now
                ? { count: current.count + 1, reset_at: current.reset_at }
                : { count: 1, reset_at: resetAt },
            );
            return { meta: { changes: 1 } };
          }
          throw new Error(`unhandled SQL: ${sql}`);
        },
        async first<T = unknown>(): Promise<T | null> {
          if (/^SELECT \* FROM documents/i.test(sql)) {
            const [kind, slug] = bound;
            return (documents.get(key(kind, slug)) as T) ?? null;
          }
          if (/^SELECT count FROM rate/i.test(sql)) {
            return (rate.get(String(bound[0])) as T) ?? null;
          }
          throw new Error(`unhandled SQL: ${sql}`);
        },
      };
      return statement;
    },
  };
}

const adapters: [string, () => ShareStorage][] = [
  ["MemoryStorage", () => new MemoryStorage()],
  ["D1Storage", () => new D1Storage(fakeD1())],
];

describe.each(adapters)("ShareStorage contract: %s", (_name, make) => {
  it("claims a slug atomically and refuses a second claim", async () => {
    const storage = make();
    expect(await storage.create(doc())).toBe(true);
    // Live or tombstoned, the slug is never reassigned.
    expect(await storage.create(doc({ tokenHash: "b".repeat(64) }))).toBe(false);
    expect((await storage.get("list", "lisbon-eats"))?.tokenHash).toBe("a".repeat(64));
  });

  it("keeps kinds as separate namespaces", async () => {
    const storage = make();
    await storage.create(doc());
    expect(await storage.get("post", "lisbon-eats")).toBeUndefined();
    expect(await storage.create(doc({ kind: "post" }))).toBe(true);
  });

  it("updates only a live row", async () => {
    const storage = make();
    await storage.create(doc());

    expect(await storage.update("post", "lisbon-eats", '{"v":2}', LATER)).toBe(false);
    expect(await storage.update("list", "lisbon-eats", '{"v":2}', LATER)).toBe(true);
    expect(await storage.get("list", "lisbon-eats")).toMatchObject({
      body: '{"v":2}',
      updatedAt: LATER,
    });

    await storage.revoke("list", "lisbon-eats", LATER);
    expect(await storage.update("list", "lisbon-eats", '{"v":3}', LATER)).toBe(false);
  });

  it("revokes into a bodiless tombstone and leaves an existing tombstone alone", async () => {
    const storage = make();
    await storage.create(doc());
    await storage.revoke("list", "lisbon-eats", LATER);

    const tombstone = await storage.get("list", "lisbon-eats");
    expect(tombstone).toMatchObject({ revokedAt: LATER, body: "" });

    // Idempotent: a repeat revoke does not move the tombstone's timestamp.
    await storage.revoke("list", "lisbon-eats", "2026-07-27T00:00:00.000Z");
    expect((await storage.get("list", "lisbon-eats"))?.revokedAt).toBe(LATER);
    // Revoking a slug that never existed is a no-op, not an error.
    await storage.revoke("list", "never-was", LATER);
    expect(await storage.get("list", "never-was")).toBeUndefined();
  });

  it("counts hits within a fixed window and resets in the next one", async () => {
    const storage = make();
    expect(await storage.hit("bucket", 60_000, 1_000)).toBe(1);
    expect(await storage.hit("bucket", 60_000, 2_000)).toBe(2);
    // A different bucket is independent; a later window starts over.
    expect(await storage.hit("other", 60_000, 2_000)).toBe(1);
    expect(await storage.hit("bucket", 60_000, 120_000)).toBe(1);
  });
});
