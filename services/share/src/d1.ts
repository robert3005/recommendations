/**
 * D1 adapter (spec/src/tech-stack.md: transactional SQL for atomic slug claims
 * and conditional revision updates — not KV). Minimal structural typing keeps
 * the package free of a workers-types dependency.
 */
import type {
  AuditEntry,
  CreateCommit,
  DocumentKind,
  IdempotencyRecord,
  ShareStorage,
  StoredDocument,
  UpdateCommit,
} from "./storage";

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
  /** Transactional statement group — D1 executes a batch atomically. */
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export class D1Storage implements ShareStorage {
  constructor(private readonly db: D1Like) {}

  async get(kind: DocumentKind, slug: string): Promise<StoredDocument | undefined> {
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
      // other database failure (outage, CHECK constraint, …) propagates
      // instead of masquerading as a collision (which would 409 + "denied").
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return false;
      throw err;
    }
  }

  async update(
    kind: DocumentKind,
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
    kind: DocumentKind,
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
      .prepare(
        "INSERT OR IGNORE INTO idempotency (key, response, status, createdAt) " +
          "VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      )
      .bind(key, record.response, record.status)
      .run();
  }

  private auditStatement(entry: AuditEntry): D1PreparedStatement {
    return this.db
      .prepare("INSERT INTO audit (at, slug, kind, action, revision) VALUES (?, ?, ?, ?, ?)")
      .bind(entry.at, entry.slug, entry.kind, entry.action, entry.revision ?? null);
  }

  private idempotentStatement(record: IdempotencyRecord): D1PreparedStatement {
    const key = record.status >= 200 ? record.key : `pending:${record.key}`;
    return this.db
      .prepare(
        "INSERT OR IGNORE INTO idempotency (key, response, status, createdAt) " +
          "VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      )
      .bind(key, record.response, record.status);
  }

  async createCommit(input: CreateCommit): Promise<"created" | "collision"> {
    // Transactional commits REQUIRE the batch API — sequential writes cannot
    // give the all-or-nothing guarantee, so fail closed before any write.
    if (!this.db.batch) {
      throw new Error("D1 batch API unavailable — transactional commits require it");
    }
    const doc = input.document;
    try {
      // ONE atomic D1 unit: audit, key reservation, slug claim, replayable ack.
      await this.db.batch([
        this.auditStatement(input.audit),
        this.idempotentStatement({ key: input.reservationKey, response: "", status: 0 }),
        this.db
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
          ),
        this.idempotentStatement({
          key: input.reservationKey,
          response: input.response,
          status: 201,
        }),
      ]);
      return "created";
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        return "collision";
      }
      throw err;
    }
  }

  async updateCommit(input: UpdateCommit): Promise<StoredDocument | "conflict" | "missing"> {
    // Transactional commits REQUIRE the batch API — sequential writes cannot
    // give the all-or-nothing guarantee, so fail closed before any write.
    if (!this.db.batch) {
      throw new Error("D1 batch API unavailable — transactional commits require it");
    }
    const existing = await this.get(input.kind, input.slug);
    if (!existing || existing.revoked) return "missing";
    if (existing.revision !== input.expectedRevision) return "conflict";
    // ONE atomic D1 unit (spec/src/sharing.md §Share service): the guarded
    // conditional write, then audit, reservation, and — last — the replayable
    // acknowledgement. A changes-0 UPDATE is still a "successful" SQL
    // statement, so the revision guard directly after it turns a lost race
    // into a STATEMENT FAILURE (NULL into the NOT NULL idempotency key),
    // aborting and rolling back the whole batch: a lost or interrupted commit
    // leaves nothing durable — no audit row, no reservation, and never a
    // replayable success for a write that did not apply.
    const conditionalWrite = this.db
      .prepare(
        "UPDATE documents SET revision = revision + 1, body = ?, updatedAt = ? WHERE kind = ? AND slug = ? AND revision = ? AND revoked = 0",
      )
      .bind(input.body, input.updatedAt, input.kind, input.slug, input.expectedRevision);
    const revisionGuard = this.db.prepare(
      "INSERT INTO idempotency (key, response, status, createdAt) " +
        "SELECT NULL, '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE changes() = 0",
    );
    try {
      await this.db.batch([
        conditionalWrite,
        revisionGuard,
        this.auditStatement(input.audit),
        this.idempotentStatement({ key: input.reservationKey, response: "", status: 0 }),
        this.idempotentStatement({
          key: input.reservationKey,
          response: input.response,
          status: 200,
        }),
      ]);
    } catch (err) {
      // The guard's designed failure IS the lost race; anything else is a
      // real storage failure and must surface for retry.
      if (
        err instanceof Error &&
        /NOT NULL constraint failed: idempotency\.key/i.test(err.message)
      ) {
        return "conflict";
      }
      throw err;
    }
    // The acknowledgement is THIS update's committed transition — a later
    // writer may already have advanced the document, and its state must
    // never masquerade as ours.
    return {
      ...existing,
      revision: input.expectedRevision + 1,
      body: input.body,
      updatedAt: input.updatedAt,
    };
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
