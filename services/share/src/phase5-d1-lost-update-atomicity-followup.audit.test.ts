/**
 * A D1 batch only rolls back when a statement fails. A conditional UPDATE
 * that affects zero rows is still a successful SQL statement, so a concurrent
 * writer must not let the following replayable acknowledgement commit.
 *
 * Spec contract: create/update are one all-or-nothing storage unit and an
 * interrupted or lost-race commit leaves nothing durable.
 */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";
import type { StoredDocument } from "./storage";

interface Result {
  meta: { changes: number };
}

class RaceStatement {
  values: unknown[] = [];

  constructor(
    private readonly database: LostUpdateD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): RaceStatement {
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

/** Simulates a competing update after D1Storage's pre-read but before its batch. */
class LostUpdateD1 implements D1Like {
  document: StoredDocument = {
    slug: "race",
    kind: "list",
    revision: 1,
    tokenHash: "token-hash",
    body: '{"title":"before"}',
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    revoked: false,
  };
  readonly idempotency = new Map<string, { key: string; response: string; status: number }>();
  auditCount = 0;

  prepare(sql: string): RaceStatement {
    return new RaceStatement(this, sql);
  }

  async batch(statements: RaceStatement[]): Promise<Result[]> {
    // The authorization/preflight read saw revision 1. Another valid request
    // wins immediately before this request's conditional UPDATE executes.
    this.document = {
      ...this.document,
      revision: 2,
      body: '{"title":"winner"}',
      updatedAt: "2026-07-19T12:00:01.000Z",
    };
    return Promise.all(statements.map((statement) => statement.run()));
  }

  private lastWriteChanges = 1;

  run(sql: string, values: readonly unknown[]): Result {
    if (sql.startsWith("INSERT INTO audit")) {
      this.auditCount += 1;
      return { meta: { changes: 1 } };
    }
    // The revision guard: SQLite fails the whole batch (NULL primary key)
    // exactly when the preceding conditional write changed zero rows.
    if (sql.startsWith("INSERT INTO idempotency")) {
      if (this.lastWriteChanges === 0) {
        throw new Error("NOT NULL constraint failed: idempotency.key");
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO idempotency")) {
      const row = {
        key: String(values[0]),
        response: String(values[1]),
        status: Number(values[2]),
      };
      if (this.idempotency.has(row.key)) return { meta: { changes: 0 } };
      this.idempotency.set(row.key, row);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE documents SET revision = revision + 1")) {
      const expectedRevision = Number(values[4]);
      if (this.document.revision !== expectedRevision) {
        this.lastWriteChanges = 0;
        return { meta: { changes: 0 } };
      }
      this.document = {
        ...this.document,
        revision: this.document.revision + 1,
        body: String(values[0]),
        updatedAt: String(values[1]),
      };
      this.lastWriteChanges = 1;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected D1 write: ${sql}`);
  }

  first(sql: string, values: readonly unknown[]): unknown {
    if (sql.startsWith("SELECT * FROM documents")) {
      return this.document.kind === values[0] && this.document.slug === values[1]
        ? { ...this.document, revoked: this.document.revoked ? 1 : 0 }
        : null;
    }
    if (sql.startsWith("SELECT * FROM idempotency")) {
      return this.idempotency.get(String(values[0])) ?? null;
    }
    throw new Error(`Unexpected D1 read: ${sql}`);
  }
}

describe("Phase 5 D1 lost-update atomicity", () => {
  it("does not commit audit, reservation, or replayable success when the conditional write loses", async () => {
    const database = new LostUpdateD1();
    const storage = new D1Storage(database);
    const key = "list:put:race:token-hash:job";

    await expect(
      storage.updateCommit({
        audit: {
          at: "2026-07-19T12:00:02.000Z",
          slug: "race",
          kind: "list",
          action: "update",
          revision: 2,
        },
        reservationKey: key,
        kind: "list",
        slug: "race",
        expectedRevision: 1,
        body: '{"title":"loser"}',
        updatedAt: "2026-07-19T12:00:02.000Z",
        response: '{"slug":"race","revision":2}',
      }),
    ).resolves.toBe("conflict");

    const replay = await storage.getIdempotent(key);
    expect(database.document.body).toBe('{"title":"winner"}');
    expect({
      auditCount: database.auditCount,
      pendingReservation: database.idempotency.has(`pending:${key}`),
      replayStatus: replay?.status,
    }).toEqual({
      auditCount: 0,
      pendingReservation: false,
      replayStatus: undefined,
    });
  });
});
