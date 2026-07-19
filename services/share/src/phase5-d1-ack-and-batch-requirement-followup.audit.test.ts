/**
 * D1 update acknowledgements describe the revision committed by that request,
 * even if another writer commits before the adapter returns. D1 deployments
 * without a transactional batch primitive must reject commits before making
 * any durable write rather than approximating a transaction sequentially.
 */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";
import type { CreateCommit, StoredDocument, UpdateCommit } from "./storage";

interface Result {
  meta: { changes: number };
}

const initialDocument = (): StoredDocument => ({
  slug: "stable-ack",
  kind: "list",
  revision: 1,
  tokenHash: "token-hash",
  body: '{"title":"revision one"}',
  createdAt: "2026-07-19T12:00:00.000Z",
  updatedAt: "2026-07-19T12:00:00.000Z",
  revoked: false,
});

const updateInput = (): UpdateCommit => ({
  audit: {
    at: "2026-07-19T12:00:01.000Z",
    slug: "stable-ack",
    kind: "list",
    action: "update",
    revision: 2,
  },
  reservationKey: "list:put:stable-ack:token-hash:first-update",
  kind: "list",
  slug: "stable-ack",
  expectedRevision: 1,
  body: '{"title":"revision two"}',
  updatedAt: "2026-07-19T12:00:01.000Z",
  response: '{"slug":"stable-ack","revision":2}',
});

const createInput = (): CreateCommit => ({
  audit: {
    at: "2026-07-19T12:00:01.000Z",
    slug: "new-guide",
    kind: "list",
    action: "create",
    revision: 1,
  },
  reservationKey: "list:post:new-guide:token-hash:create",
  document: {
    ...initialDocument(),
    slug: "new-guide",
    body: '{"title":"new guide"}',
  },
  response: '{"slug":"new-guide","revision":1}',
});

class Statement<Database extends StatementDatabase> {
  values: unknown[] = [];

  constructor(
    private readonly database: Database,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): Statement<Database> {
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

interface StatementDatabase {
  run(sql: string, values: readonly unknown[]): Result;
  first(sql: string, values: readonly unknown[]): unknown;
}

/** Advances to revision 3 immediately after revision 2's acknowledgement commits. */
class LaterWriterD1 implements D1Like, StatementDatabase {
  document = initialDocument();
  readonly idempotency = new Map<string, { key: string; response: string; status: number }>();
  private advanceAfterBatch = false;

  prepare(sql: string): Statement<LaterWriterD1> {
    return new Statement(this, sql);
  }

  async batch(statements: Statement<LaterWriterD1>[]): Promise<Result[]> {
    const results: Result[] = [];
    for (const statement of statements) results.push(await statement.run());

    if (this.advanceAfterBatch) {
      this.advanceAfterBatch = false;
      this.document = {
        ...this.document,
        revision: 3,
        body: '{"title":"revision three"}',
        updatedAt: "2026-07-19T12:00:02.000Z",
      };
    }
    return results;
  }

  run(sql: string, values: readonly unknown[]): Result {
    if (sql.startsWith("INSERT INTO audit")) return { meta: { changes: 1 } };
    if (sql.startsWith("INSERT OR IGNORE INTO idempotency")) {
      const row = {
        key: String(values[0]),
        response: String(values[1]),
        status: Number(values[2]),
      };
      if (this.idempotency.has(row.key)) return { meta: { changes: 0 } };
      this.idempotency.set(row.key, row);
      if (row.status === 200) this.advanceAfterBatch = true;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE documents SET revision = revision + 1")) {
      const expectedRevision = Number(values[4]);
      if (this.document.revision !== expectedRevision) return { meta: { changes: 0 } };
      this.document = {
        ...this.document,
        revision: this.document.revision + 1,
        body: String(values[0]),
        updatedAt: String(values[1]),
      };
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

/** A functional non-transactional adapter, used to expose sequential fallback writes. */
class NoBatchD1 implements D1Like, StatementDatabase {
  document = initialDocument();
  readonly writes: string[] = [];

  prepare(sql: string): Statement<NoBatchD1> {
    return new Statement(this, sql);
  }

  run(sql: string, values: readonly unknown[]): Result {
    this.writes.push(sql);
    if (sql.startsWith("UPDATE documents SET revision = revision + 1")) {
      this.document = {
        ...this.document,
        revision: this.document.revision + 1,
        body: String(values[0]),
        updatedAt: String(values[1]),
      };
    }
    return { meta: { changes: 1 } };
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

describe("Phase 5 D1 acknowledgement and transaction requirements", () => {
  it("returns and replays the first update's own acknowledgement after a later update", async () => {
    const database = new LaterWriterD1();
    const storage = new D1Storage(database);
    const input = updateInput();

    const result = await storage.updateCommit(input);
    const replay = await storage.getIdempotent(input.reservationKey);

    expect(database.document).toMatchObject({ revision: 3, body: '{"title":"revision three"}' });
    expect(result).toMatchObject({ revision: 2, body: input.body, updatedAt: input.updatedAt });
    expect(replay).toEqual({
      key: input.reservationKey,
      response: input.response,
      status: 200,
    });
  });

  it.each([
    ["create", (storage: D1Storage) => storage.createCommit(createInput())],
    ["update", (storage: D1Storage) => storage.updateCommit(updateInput())],
  ])("fails closed before a %s commit when D1 batch is unavailable", async (_name, commit) => {
    const database = new NoBatchD1();
    let failure: unknown;
    try {
      await commit(new D1Storage(database));
    } catch (error) {
      failure = error;
    }

    expect.soft(failure).toBeInstanceOf(Error);
    expect(database.writes).toEqual([]);
  });
});
