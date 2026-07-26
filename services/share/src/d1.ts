/**
 * D1 adapter (spec/src/tech-stack.md: Workers + D1). Minimal structural typing
 * keeps the package free of a workers-types dependency. Columns are snake_case
 * per the schema in spec/src/sharing.md §The share service.
 */
import type { DocumentKind, ShareStorage, StoredDocument } from "./storage";

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

interface DocumentRow {
  kind: DocumentKind;
  slug: string;
  token_hash: string;
  body: string;
  revoked_at: string | null;
  updated_at: string;
}

export class D1Storage implements ShareStorage {
  constructor(private readonly db: D1Like) {}

  async get(kind: DocumentKind, slug: string): Promise<StoredDocument | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM documents WHERE kind = ?1 AND slug = ?2")
      .bind(kind, slug)
      .first<DocumentRow>();
    if (!row) return undefined;
    return {
      kind: row.kind,
      slug: row.slug,
      tokenHash: row.token_hash,
      body: row.body,
      revokedAt: row.revoked_at,
      updatedAt: row.updated_at,
    };
  }

  async create(doc: StoredDocument): Promise<boolean> {
    try {
      await this.db
        .prepare(
          "INSERT INTO documents (kind, slug, token_hash, body, revoked_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        )
        .bind(doc.kind, doc.slug, doc.tokenHash, doc.body, doc.updatedAt)
        .run();
      return true;
    } catch (err) {
      // Only a PRIMARY KEY (kind, slug) violation is a lost claim; any other
      // database failure (outage, CHECK constraint, …) propagates instead of
      // masquerading as a collision.
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return false;
      throw err;
    }
  }

  async update(
    kind: DocumentKind,
    slug: string,
    body: string,
    updatedAt: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE documents SET body = ?1, updated_at = ?2 " +
          "WHERE kind = ?3 AND slug = ?4 AND revoked_at IS NULL",
      )
      .bind(body, updatedAt, kind, slug)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async revoke(kind: DocumentKind, slug: string, revokedAt: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE documents SET revoked_at = ?1, body = '', updated_at = ?1 " +
          "WHERE kind = ?2 AND slug = ?3 AND revoked_at IS NULL",
      )
      .bind(revokedAt, kind, slug)
      .run();
  }

  async hit(bucket: string, windowMs: number, now: number): Promise<number> {
    // ISO-8601 "T" timestamps compare chronologically as TEXT.
    const nowIso = new Date(now).toISOString();
    const resetAtIso = new Date(now + windowMs).toISOString();
    await this.db
      .prepare(
        "INSERT INTO rate (bucket, count, reset_at) VALUES (?1, 1, ?2) " +
          "ON CONFLICT(bucket) DO UPDATE SET " +
          "count = CASE WHEN rate.reset_at > ?3 THEN rate.count + 1 ELSE 1 END, " +
          "reset_at = CASE WHEN rate.reset_at > ?3 THEN rate.reset_at ELSE ?2 END",
      )
      .bind(bucket, resetAtIso, nowIso)
      .run();
    const row = await this.db
      .prepare("SELECT count FROM rate WHERE bucket = ?1")
      .bind(bucket)
      .first<{ count: number }>();
    return row?.count ?? 1;
  }
}
