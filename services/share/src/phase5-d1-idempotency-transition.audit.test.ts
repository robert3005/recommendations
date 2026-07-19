/**
 * Phase 5 D1 regression: PUT reserves an idempotency key with status 0 before
 * committing the document, then promotes that reservation to the final result.
 * D1 must expose the completed result so a retry can replay it safely.
 */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";

interface IdempotencyRow {
  key: string;
  response: string;
  status: number;
}

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const [key, response, status] = this.values;
    if (typeof key !== "string" || typeof response !== "string" || typeof status !== "number") {
      throw new Error("Invalid idempotency binding");
    }
    return {
      meta: {
        changes: this.db.executeIdempotencyWrite(this.sql, { key, response, status }) ? 1 : 0,
      },
    };
  }

  async first<T = unknown>(): Promise<T | null> {
    if (!this.sql.startsWith("SELECT * FROM idempotency")) {
      throw new Error(`Unexpected read statement: ${this.sql}`);
    }
    const [key] = this.values;
    if (typeof key !== "string") throw new Error("Invalid idempotency key binding");
    return (this.db.find(key) ?? null) as T | null;
  }
}

class FakeD1 implements D1Like {
  private readonly idempotency = new Map<string, IdempotencyRow>();

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this, sql);
  }

  executeIdempotencyWrite(sql: string, row: IdempotencyRow): boolean {
    const existing = this.idempotency.get(row.key);
    if (sql.startsWith("INSERT OR IGNORE INTO idempotency")) {
      if (existing) return false;
      this.idempotency.set(row.key, row);
      return true;
    }
    if (
      sql.startsWith("INSERT INTO idempotency") &&
      sql.includes("ON CONFLICT") &&
      sql.includes("DO UPDATE")
    ) {
      if (existing && existing.status !== 0) return false;
      this.idempotency.set(row.key, row);
      return true;
    }
    throw new Error(`Unexpected write statement: ${sql}`);
  }

  find(key: string): IdempotencyRow | undefined {
    return this.idempotency.get(key);
  }
}

describe("Phase 5 D1 idempotency transitions", () => {
  it("promotes a pending reservation to the final replayable result", async () => {
    const storage = new D1Storage(new FakeD1());
    const key = "list:put:lisbon:token-hash:publication-job";

    await storage.putIdempotent({ key, response: "", status: 0 });
    await storage.putIdempotent({
      key,
      response: JSON.stringify({ slug: "lisbon", revision: 2 }),
      status: 200,
    });

    expect(await storage.getIdempotent(key)).toEqual({
      key,
      response: JSON.stringify({ slug: "lisbon", revision: 2 }),
      status: 200,
    });
  });
});
