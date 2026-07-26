/**
 * Share-service storage port (spec/src/sharing.md §The share service): two
 * tables — `documents` and `rate`. A slug claim is one atomic INSERT; an update
 * touches only a live row; a revoke tombstones in place and the tombstone is
 * never reassigned. D1/SQL in deployment; the in-memory adapter backs tests and
 * mirrors the same semantics.
 */

/** The two public collections: /s/lists and /s/posts. */
export type DocumentKind = "list" | "post";

export interface StoredDocument {
  kind: DocumentKind;
  slug: string;
  /** SHA-256 hex of the editor bearer token — never the token itself. */
  tokenHash: string;
  /** Serialized published document JSON; empty once revoked. */
  body: string;
  /** Set on revoke; a tombstoned slug is never reassigned. */
  revokedAt: string | null;
  updatedAt: string;
}

export interface ShareStorage {
  get(kind: DocumentKind, slug: string): Promise<StoredDocument | undefined>;
  /** Atomic claim: fails (returns false) when the slug exists — live or tombstoned. */
  create(doc: StoredDocument): Promise<boolean>;
  /** Replace a live document's body; false when the row is missing or tombstoned. */
  update(kind: DocumentKind, slug: string, body: string, updatedAt: string): Promise<boolean>;
  /** Tombstone: set revokedAt and clear the body. Already-revoked rows are untouched. */
  revoke(kind: DocumentKind, slug: string, revokedAt: string): Promise<void>;
  /** Fixed-window rate counter; returns the count within the window including this hit. */
  hit(bucket: string, windowMs: number, now: number): Promise<number>;
}

export class MemoryStorage implements ShareStorage {
  private docs = new Map<string, StoredDocument>();
  private buckets = new Map<string, { resetAt: number; count: number }>();

  private key(kind: DocumentKind, slug: string): string {
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
    body: string,
    updatedAt: string,
  ): Promise<boolean> {
    const doc = this.docs.get(this.key(kind, slug));
    if (!doc || doc.revokedAt !== null) return false;
    this.docs.set(this.key(kind, slug), { ...doc, body, updatedAt });
    return true;
  }

  async revoke(kind: DocumentKind, slug: string, revokedAt: string): Promise<void> {
    const doc = this.docs.get(this.key(kind, slug));
    if (!doc || doc.revokedAt !== null) return;
    this.docs.set(this.key(kind, slug), { ...doc, revokedAt, body: "", updatedAt: revokedAt });
  }

  async hit(bucket: string, windowMs: number, now: number): Promise<number> {
    const current = this.buckets.get(bucket);
    if (!current || now >= current.resetAt) {
      this.buckets.set(bucket, { resetAt: now + windowMs, count: 1 });
      return 1;
    }
    current.count += 1;
    return current.count;
  }
}
