/**
 * Share-service storage port (book/src/sharing.md §Share service): a
 * transactional, consistent store — atomic slug claims and conditional
 * revision updates. D1/SQL in deployment; the in-memory adapter backs tests
 * and mirrors the same semantics.
 */

export interface StoredDocument {
  slug: string;
  kind: "list" | "note";
  /** Monotonic per-slug revision; doubles as the ETag value. */
  revision: number;
  /** SHA-256 hex of the editor bearer token — never the token itself. */
  tokenHash: string;
  /** Serialized SharedGuide/SharedNote JSON. */
  body: string;
  createdAt: string;
  updatedAt: string;
  /** A revoked slug keeps a non-readable tombstone; it is never reassigned. */
  revoked: boolean;
}

export interface AuditEntry {
  at: string;
  slug: string;
  kind: "list" | "note";
  action: "create" | "update" | "revoke" | "denied" | "read";
  revision?: number;
}

export interface IdempotencyRecord {
  key: string;
  /** Serialized response replayed for retries of the same job. */
  response: string;
  status: number;
}

/** One transactional first-publish commit: audit, key reservation, claim, ack. */
export interface CreateCommit {
  audit: AuditEntry;
  reservationKey: string;
  document: StoredDocument;
  /** The replayable success body — stored (status 201) only after the claim. */
  response: string;
}

/** One transactional update commit: audit, key reservation, conditional write, ack. */
export interface UpdateCommit {
  audit: AuditEntry;
  reservationKey: string;
  kind: "list" | "note";
  slug: string;
  expectedRevision: number;
  body: string;
  updatedAt: string;
  /** The replayable success body — stored (status 200) only after the write. */
  response: string;
}

export interface ShareStorage {
  get(kind: "list" | "note", slug: string): Promise<StoredDocument | undefined>;
  /** Atomic claim: fails (returns false) when the slug exists — live or tombstoned. */
  create(doc: StoredDocument): Promise<boolean>;
  /**
   * The whole first-publish transition as ONE unit: audit → key reservation →
   * atomic slug claim → replayable success. An interrupted commit leaves
   * nothing behind; the replayable record is the commit acknowledgement.
   */
  createCommit(input: CreateCommit): Promise<"created" | "collision">;
  /** The whole update transition as ONE unit (same ordering guarantees). */
  updateCommit(input: UpdateCommit): Promise<StoredDocument | "conflict" | "missing">;
  /** Conditional update: applies only when the stored revision matches; returns the new doc. */
  update(
    kind: "list" | "note",
    slug: string,
    expectedRevision: number,
    body: string,
    updatedAt: string,
  ): Promise<StoredDocument | "conflict" | "missing">;
  /** Conditional revoke → tombstone. */
  revoke(
    kind: "list" | "note",
    slug: string,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<"ok" | "conflict" | "missing">;
  audit(entry: AuditEntry): Promise<void>;
  getIdempotent(key: string): Promise<IdempotencyRecord | undefined>;
  putIdempotent(record: IdempotencyRecord): Promise<void>;
  /** Fixed-window rate counter; returns the count within the window including this hit. */
  hit(bucket: string, windowMs: number, now: number): Promise<number>;
}

export class MemoryStorage implements ShareStorage {
  private docs = new Map<string, StoredDocument>();
  private auditLog: AuditEntry[] = [];
  private idempotency = new Map<string, IdempotencyRecord>();
  private buckets = new Map<string, { windowStart: number; count: number }>();

  private key(kind: string, slug: string): string {
    return `${kind}:${slug}`;
  }

  async get(kind: "list" | "note", slug: string): Promise<StoredDocument | undefined> {
    return this.docs.get(this.key(kind, slug));
  }

  async create(doc: StoredDocument): Promise<boolean> {
    const key = this.key(doc.kind, doc.slug);
    if (this.docs.has(key)) return false;
    this.docs.set(key, doc);
    return true;
  }

  /** Snapshot/restore helpers give the in-memory adapter real commit atomicity. */
  private commitSnapshot(docKey: string, reservationKey: string) {
    const doc = this.docs.get(docKey);
    const record = this.idempotency.get(reservationKey);
    const auditLength = this.auditLog.length;
    return () => {
      if (doc) this.docs.set(docKey, doc);
      else this.docs.delete(docKey);
      if (record) this.idempotency.set(reservationKey, record);
      else this.idempotency.delete(reservationKey);
      this.auditLog.length = auditLength;
    };
  }

  async createCommit(input: CreateCommit): Promise<"created" | "collision"> {
    const restore = this.commitSnapshot(
      this.key(input.document.kind, input.document.slug),
      input.reservationKey,
    );
    try {
      await this.audit(input.audit);
      await this.putIdempotent({ key: input.reservationKey, response: "", status: 0 });
      const created = await this.create(input.document);
      if (!created) {
        // The claim was lost — this attempt contributes nothing durable.
        restore();
        return "collision";
      }
      await this.putIdempotent({
        key: input.reservationKey,
        response: input.response,
        status: 201,
      });
      return "created";
    } catch (err) {
      restore();
      throw err;
    }
  }

  async updateCommit(input: UpdateCommit): Promise<StoredDocument | "conflict" | "missing"> {
    const restore = this.commitSnapshot(this.key(input.kind, input.slug), input.reservationKey);
    try {
      await this.audit(input.audit);
      await this.putIdempotent({ key: input.reservationKey, response: "", status: 0 });
      const result = await this.update(
        input.kind,
        input.slug,
        input.expectedRevision,
        input.body,
        input.updatedAt,
      );
      if (result === "missing" || result === "conflict") {
        restore();
        return result;
      }
      await this.putIdempotent({
        key: input.reservationKey,
        response: input.response,
        status: 200,
      });
      return result;
    } catch (err) {
      restore();
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
    const doc = this.docs.get(this.key(kind, slug));
    if (!doc || doc.revoked) return "missing";
    if (doc.revision !== expectedRevision) return "conflict";
    const next = { ...doc, revision: doc.revision + 1, body, updatedAt };
    this.docs.set(this.key(kind, slug), next);
    return next;
  }

  async revoke(
    kind: "list" | "note",
    slug: string,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<"ok" | "conflict" | "missing"> {
    const doc = this.docs.get(this.key(kind, slug));
    if (!doc || doc.revoked) return "missing";
    if (doc.revision !== expectedRevision) return "conflict";
    this.docs.set(this.key(kind, slug), {
      ...doc,
      revoked: true,
      body: "",
      revision: doc.revision + 1,
      updatedAt,
    });
    return "ok";
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }

  async getIdempotent(key: string): Promise<IdempotencyRecord | undefined> {
    return this.idempotency.get(key);
  }

  async putIdempotent(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(record.key, record);
  }

  async hit(bucket: string, windowMs: number, now: number): Promise<number> {
    const current = this.buckets.get(bucket);
    if (!current || now - current.windowStart >= windowMs) {
      this.buckets.set(bucket, { windowStart: now, count: 1 });
      return 1;
    }
    current.count += 1;
    return current.count;
  }

  /** Test visibility. */
  get auditEntries(): readonly AuditEntry[] {
    return this.auditLog;
  }
}
