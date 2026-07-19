/**
 * The authoritative D1 update is one transactional batch. A document write
 * must not commit in an earlier "probe" batch and survive when the later
 * audit/reservation/ack batch fails.
 */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";
import type { StoredDocument } from "./storage";

interface Result {
  meta: { changes: number };
}

class Statement {
  values: unknown[] = [];

  constructor(
    private readonly database: SplitBatchFailureD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): Statement {
    this.values = values;
    return this;
  }

  run(): Promise<Result> {
    return Promise.resolve(this.database.run(this.sql, this.values));
  }

  first<T = unknown>(): Promise<T | null> {
    return Promise.resolve(this.database.first(this.sql, this.values) as T | null);
  }
}

/**
 * A full bookkeeping batch fails atomically. Any earlier update-only batch,
 * however, has already committed and exposes the forbidden split transition.
 */
class SplitBatchFailureD1 implements D1Like {
  document: StoredDocument = {
    slug: "one-unit",
    kind: "list",
    revision: 1,
    tokenHash: "token-hash",
    body: '{"title":"before"}',
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    revoked: false,
  };
  readonly batches: string[][] = [];

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  async batch(statements: Statement[]): Promise<Result[]> {
    this.batches.push(statements.map((statement) => statement.sql));
    if (statements.some((statement) => statement.sql.startsWith("INSERT INTO audit"))) {
      throw new Error("simulated atomic bookkeeping failure");
    }
    return Promise.all(statements.map((statement) => statement.run()));
  }

  run(sql: string, values: readonly unknown[]): Result {
    if (sql.startsWith("UPDATE documents SET revision = revision + 1")) {
      if (this.document.revision !== Number(values[4])) return { meta: { changes: 0 } };
      this.document = {
        ...this.document,
        revision: this.document.revision + 1,
        body: String(values[0]),
        updatedAt: String(values[1]),
      };
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected D1 write outside failed batch: ${sql}`);
  }

  first(sql: string, values: readonly unknown[]): unknown {
    if (sql.startsWith("SELECT * FROM documents")) {
      return this.document.kind === values[0] && this.document.slug === values[1]
        ? { ...this.document, revoked: this.document.revoked ? 1 : 0 }
        : null;
    }
    if (sql.startsWith("SELECT * FROM idempotency")) return null;
    throw new Error(`Unexpected D1 read: ${sql}`);
  }
}

describe("Phase 5 D1 single-batch update interruption", () => {
  it("leaves the document unchanged when the update commit batch fails", async () => {
    const database = new SplitBatchFailureD1();
    const storage = new D1Storage(database);

    await expect(
      storage.updateCommit({
        audit: {
          at: "2026-07-19T12:00:01.000Z",
          slug: "one-unit",
          kind: "list",
          action: "update",
          revision: 2,
        },
        reservationKey: "list:put:one-unit:token-hash:job",
        kind: "list",
        slug: "one-unit",
        expectedRevision: 1,
        body: '{"title":"after"}',
        updatedAt: "2026-07-19T12:00:01.000Z",
        response: '{"slug":"one-unit","revision":2}',
      }),
    ).rejects.toThrow(/simulated atomic bookkeeping failure/i);

    expect(database.batches).toHaveLength(1);
    expect(database.document).toMatchObject({
      revision: 1,
      body: '{"title":"before"}',
    });
  });
});
