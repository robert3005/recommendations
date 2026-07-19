/**
 * D1 adapter (book/src/tech-stack.md: transactional SQL for atomic slug claims
 * and conditional revision updates — not KV). Minimal structural typing keeps
 * the package free of a workers-types dependency.
 */
import type { AuditEntry, IdempotencyRecord, ShareStorage, StoredDocument } from "./storage";

interface D1Result {
  results?: unknown[];
  meta?: { changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T = unknown>(): Promise<T | null>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
}

export class D1Storage implements ShareStorage {
  constructor(private readonly db: D1Like) {}

  async get(kind: "list" | "note", slug: string): Promise<StoredDocument | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM documents WHERE kind = ? AND slug = ?")
      .bind(kind, slug)
      .first<Omit<StoredDocument, "revoked"> & { revoked: number }>();
    if (!row) return undefined;
    return { ...row, revoked: row.revoked === 1 };
  }

  async create(doc: StoredDocument): Promise<boolean> {
    try {
      await this.db
        .prepare(
          "INSERT INTO documents (slug, kind, revision, tokenHash, body, createdAt, updatedAt, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(
          doc.slug,
          doc.kind,
          doc.revision,
          doc.tokenHash,
          doc.body,
          doc.createdAt,
          doc.updatedAt,
        )
        .run();
      return true;
    } catch (err) {
      // Only a UNIQUE(slug, kind) violation is a failed atomic claim; any
      // other database failure propagates instead of masquerading as a
      // collision (which would 409 and audit "denied").
      if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) return false;
      throw err;
    }
  }

  async update(
    kind: "list" | "note",
    slug: string,
    expectedRevision: number,
    body: string,
    updatedAt: string,
  ): Promise<StoredDocument | "conflict" | "missing"> {
    const existing = await this.get(kind, slug);
    if (!existing || existing.revoked) return "missing";
    const result = await this.db
      .prepare(
        "UPDATE documents SET revision = revision + 1, body = ?, updatedAt = ? WHERE kind = ? AND slug = ? AND revision = ? AND revoked = 0",
      )
      .bind(body, updatedAt, kind, slug, expectedRevision)
      .run();
    if ((result.meta?.changes ?? 0) === 0) return "conflict";
    const updated = await this.get(kind, slug);
    return updated ?? "missing";
  }

  async revoke(
    kind: "list" | "note",
    slug: string,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<"ok" | "conflict" | "missing"> {
    const existing = await this.get(kind, slug);
    if (!existing || existing.revoked) return "missing";
    const result = await this.db
      .prepare(
        "UPDATE documents SET revoked = 1, body = '', revision = revision + 1, updatedAt = ? WHERE kind = ? AND slug = ? AND revision = ? AND revoked = 0",
      )
      .bind(updatedAt, kind, slug, expectedRevision)
      .run();
    return (result.meta?.changes ?? 0) === 0 ? "conflict" : "ok";
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.db
      .prepare("INSERT INTO audit (at, slug, kind, action, revision) VALUES (?, ?, ?, ?, ?)")
      .bind(entry.at, entry.slug, entry.kind, entry.action, entry.revision ?? null)
      .run();
  }

  async getIdempotent(key: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM idempotency WHERE key = ?")
      .bind(key)
      .first<IdempotencyRecord>();
    if (row) return row;
    // A reservation not yet promoted surfaces as pending — never as success.
    const pending = await this.db
      .prepare("SELECT * FROM idempotency WHERE key = ?")
      .bind(`pending:${key}`)
      .first<IdempotencyRecord>();
    return pending ? { ...pending, key } : undefined;
  }

  async putIdempotent(record: IdempotencyRecord): Promise<void> {
    // Records are immutable inserts. A pending reservation (status 0) lives
    // under a state-prefixed key, so promoting it to the final replayable
    // result is a fresh INSERT of the bare key — no UPDATE ever needed.
    const key = record.status >= 200 ? record.key : `pending:${record.key}`;
    await this.db
      .prepare("INSERT OR IGNORE INTO idempotency (key, response, status) VALUES (?, ?, ?)")
      .bind(key, record.response, record.status)
      .run();
  }

  async hit(bucket: string, windowMs: number, now: number): Promise<number> {
    const windowStart = now - (now % windowMs);
    await this.db
      .prepare(
        "INSERT INTO rate (bucket, windowStart, count) VALUES (?, ?, 1) " +
          "ON CONFLICT(bucket) DO UPDATE SET " +
          "count = CASE WHEN windowStart = excluded.windowStart THEN count + 1 ELSE 1 END, " +
          "windowStart = excluded.windowStart",
      )
      .bind(bucket, windowStart)
      .run();
    const row = await this.db
      .prepare("SELECT count FROM rate WHERE bucket = ?")
      .bind(bucket)
      .first<{ count: number }>();
    return row?.count ?? 1;
  }
}
