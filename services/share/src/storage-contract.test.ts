/**
 * One contract, run against BOTH `ShareStorage` adapters.
 *
 * This replaces ten hand-written D1 fakes that each asserted on SQL string
 * prefixes for a different corner of the old multi-statement commit unit. With
 * each verb a single statement, what matters is that the memory adapter and the
 * D1 adapter agree on the semantics the service depends on — atomic claim,
 * conditional update, conditional revoke, immutable replay handles, fixed-window
 * counters — so those are stated once, here.
 */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";
import { MemoryStorage, type ShareStorage, type StoredDocument } from "./storage";

const NOW = "2026-07-20T12:00:00.000Z";
const LATER = "2026-07-20T13:00:00.000Z";

function doc(overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    slug: "lisbon-eats",
    kind: "list",
    revision: 1,
    tokenHash: "a".repeat(64),
    body: '{"v":1}',
    createdAt: NOW,
    updatedAt: NOW,
    revoked: false,
    ...overrides,
  };
}

/**
 * A SQLite-shaped fake: enough of D1 to exercise the adapter's real SQL through
 * the same code path the Worker uses, without pinning statement text.
 */
function fakeD1(): D1Like {
  const documents = new Map<string, Record<string, unknown>>();
  const idempotency = new Map<string, Record<string, unknown>>();
  const rate = new Map<string, { windowStart: number; count: number }>();
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
            const [slug, kind, revision, tokenHash, body, createdAt, updatedAt] = bound;
            const id = key(kind, slug);
            if (documents.has(id)) throw new Error("UNIQUE constraint failed: documents.slug");
            documents.set(id, {
              slug,
              kind,
              revision,
              tokenHash,
              body,
              createdAt,
              updatedAt,
              revoked: 0,
            });
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE documents SET revoked = 1/i.test(sql)) {
            const [updatedAt, kind, slug, expected] = bound;
            const row = documents.get(key(kind, slug));
            if (!row || row.revoked === 1 || row.revision !== expected) {
              return { meta: { changes: 0 } };
            }
            Object.assign(row, {
              revoked: 1,
              body: "",
              revision: (row.revision as number) + 1,
              updatedAt,
            });
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE documents SET revision/i.test(sql)) {
            const [body, updatedAt, kind, slug, expected] = bound;
            const row = documents.get(key(kind, slug));
            if (!row || row.revoked === 1 || row.revision !== expected) {
              return { meta: { changes: 0 } };
            }
            Object.assign(row, { revision: (row.revision as number) + 1, body, updatedAt });
            return { meta: { changes: 1 } };
          }
          if (/^INSERT OR IGNORE INTO idempotency/i.test(sql)) {
            const [k, response, status] = bound;
            // OR IGNORE: handles are immutable once written.
            if (!idempotency.has(String(k))) {
              idempotency.set(String(k), { key: k, response, status, createdAt: NOW });
            }
            return { meta: { changes: 1 } };
          }
          if (/^INSERT INTO rate/i.test(sql)) {
            const bucket = String(bound[0]);
            const windowStart = Number(bound[1]);
            const current = rate.get(bucket);
            rate.set(
              bucket,
              current && current.windowStart === windowStart
                ? { windowStart, count: current.count + 1 }
                : { windowStart, count: 1 },
            );
            return { meta: { changes: 1 } };
          }
          if (/^DELETE FROM idempotency/i.test(sql)) {
            idempotency.clear();
            return { meta: { changes: 1 } };
          }
          throw new Error(`unhandled SQL: ${sql}`);
        },
        async first<T = unknown>(): Promise<T | null> {
          if (/^SELECT \* FROM documents/i.test(sql)) {
            const [kind, slug] = bound;
            return (documents.get(key(kind, slug)) as T) ?? null;
          }
          if (/^SELECT \* FROM idempotency/i.test(sql)) {
            return (idempotency.get(String(bound[0])) as T) ?? null;
          }
          if (/rate/i.test(sql)) {
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

  it("updates only on a matching revision, and bumps it", async () => {
    const storage = make();
    await storage.create(doc());

    expect(await storage.update("list", "lisbon-eats", 9, '{"v":2}', LATER)).toBe("conflict");
    expect(await storage.update("post", "lisbon-eats", 1, '{"v":2}', LATER)).toBe("missing");

    const updated = await storage.update("list", "lisbon-eats", 1, '{"v":2}', LATER);
    expect(updated).toMatchObject({ revision: 2, body: '{"v":2}', updatedAt: LATER });
    // The old revision cannot be replayed over the new one.
    expect(await storage.update("list", "lisbon-eats", 1, '{"v":3}', LATER)).toBe("conflict");
  });

  it("revokes into a tombstone that no longer reads and cannot be re-revoked", async () => {
    const storage = make();
    await storage.create(doc());

    expect(await storage.revoke("list", "lisbon-eats", 9, LATER)).toBe("conflict");
    expect(await storage.revoke("list", "lisbon-eats", 1, LATER)).toBe("ok");

    const tombstone = await storage.get("list", "lisbon-eats");
    expect(tombstone).toMatchObject({ revoked: true, body: "" });
    // A tombstone reads as absent to both verbs — it is gone, not stale.
    expect(await storage.revoke("list", "lisbon-eats", 1, LATER)).toBe("missing");
    expect(await storage.update("list", "lisbon-eats", 2, '{"v":9}', LATER)).toBe("missing");
  });

  it("stores replay handles immutably", async () => {
    const storage = make();
    await storage.putIdempotent({ key: "job-1", response: '{"revision":1}', status: 201 });
    // A second write under the same key never overwrites the first.
    await storage.putIdempotent({ key: "job-1", response: '{"revision":99}', status: 200 });

    expect(await storage.getIdempotent("job-1")).toMatchObject({
      response: '{"revision":1}',
      status: 201,
    });
    expect(await storage.getIdempotent("job-absent")).toBeUndefined();
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
