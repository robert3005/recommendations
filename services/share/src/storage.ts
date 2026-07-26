/**
 * Share-service storage port (spec/src/sharing.md §Share service): a consistent
 * store with an atomic slug claim and a conditional revision update. D1/SQL in
 * deployment; the in-memory adapter backs tests and mirrors the same semantics.
 *
 * Each verb is a single statement. The multi-statement "commit unit" this port
 * used to expose — audit + key reservation + write + ack, batched — was
 * belt-and-braces over recovery paths that already carry the weight: a retried
 * create recovers through slug ownership and stored-body comparison, and a
 * retried revoke through its own tombstone. What it cost was a synthetic
 * NOT NULL violation used as a rollback trigger, a `pending:` key encoding, and
 * compensation logic in the memory adapter.
 */

/** The two public collections: /s/lists and /s/posts. */
export type DocumentKind = "list" | "post";

export interface StoredDocument {
  slug: string;
  kind: DocumentKind;
  /** Monotonic per-slug revision; doubles as the ETag value. */
  revision: number;
  /** SHA-256 hex of the editor bearer token — never the token itself. */
  tokenHash: string;
  /** Serialized SharedGuide JSON. */
  body: string;
  createdAt: string;
  updatedAt: string;
  /** A revoked slug keeps a non-readable tombstone; it is never reassigned. */
  revoked: boolean;
}

export interface IdempotencyRecord {
  key: string;
  /** Serialized response replayed for retries of the same job. */
  response: string;
  status: number;
}

export interface ShareStorage {
  get(kind: DocumentKind, slug: string): Promise<StoredDocument | undefined>;
  /** Atomic claim: fails (returns false) when the slug exists — live or tombstoned. */
  create(doc: StoredDocument): Promise<boolean>;
  /** Conditional update: applies only when the stored revision matches; returns the new doc. */
  update(
    kind: DocumentKind,
    slug: string,
    expectedRevision: number,
    body: string,
    updatedAt: string,
  ): Promise<StoredDocument | "conflict" | "missing">;
  /** Conditional revoke → tombstone. */
  revoke(
    kind: DocumentKind,
    slug: string,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<"ok" | "conflict" | "missing">;
  getIdempotent(key: string): Promise<IdempotencyRecord | undefined>;
  putIdempotent(record: IdempotencyRecord): Promise<void>;
  /** Fixed-window rate counter; returns the count within the window including this hit. */
  hit(bucket: string, windowMs: number, now: number): Promise<number>;
}

export class MemoryStorage implements ShareStorage {
  private docs = new Map<string, StoredDocument>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private buckets = new Map<string, { windowStart: number; count: number }>();

  private key(kind: string, slug: string): string {
    return `${kind}:${slug}`;
  }

  async get(kind: DocumentKind, slug: string): Promise<StoredDocument | undefined> {
    return this.docs.get(this.key(kind, slug));
  }

  async create(doc: StoredDocument): Promise<boolean> {
    const key = this.key(doc.kind, doc.slug);
    if (this.docs.has(key)) return false;
    this.docs.set(key, doc);
    return true;
  }

  async update(
    kind: DocumentKind,
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
    kind: DocumentKind,
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

  async getIdempotent(key: string): Promise<IdempotencyRecord | undefined> {
    return this.idempotency.get(key);
  }

  async putIdempotent(record: IdempotencyRecord): Promise<void> {
    // INSERT OR IGNORE semantics, matching D1: a handle is immutable once
    // written, so a late duplicate can never rewrite an acknowledged result.
    if (!this.idempotency.has(record.key)) this.idempotency.set(record.key, record);
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
}
