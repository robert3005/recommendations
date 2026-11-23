/**
 * Share-service storage ports. Publishing (spec/src/sharing.md §The share
 * service) uses two tables — `documents` and `rate`; sync (spec/src/sync.md)
 * adds `libraries` and `sync_rows`. A slug claim is one atomic INSERT; an update
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

/**
 * Sync storage port (spec/src/sync.md §The service): a library is claimed
 * once, by the hash of the token its key derives, and holds opaque rows. Every
 * write takes the library's next sequence number, so "everything after N" is
 * a complete, ordered answer.
 */
export interface StoredLibrary {
  id: string;
  /** SHA-256 hex of the sync bearer token — never the token itself. */
  tokenHash: string;
  createdAt: string;
}

export interface StoredSyncRow {
  k: string;
  c: string;
  seq: number;
}

export interface SyncStorage {
  getLibrary(id: string): Promise<StoredLibrary | undefined>;
  /** Atomic claim: false when the id is already taken. */
  createLibrary(library: StoredLibrary): Promise<boolean>;
  /** Upsert rows, each under the library's next sequence number; returns the last one. */
  putRows(libraryId: string, rows: readonly { k: string; c: string }[]): Promise<number>;
  /** Rows with seq > since, ascending, at most `limit`. */
  changesSince(libraryId: string, since: number, limit: number): Promise<StoredSyncRow[]>;
  countRows(libraryId: string): Promise<number>;
  /** Remove the library and every row it holds. */
  deleteLibrary(id: string): Promise<void>;
}

export class MemoryStorage implements ShareStorage, SyncStorage {
  private docs = new Map<string, StoredDocument>();
  private buckets = new Map<string, { resetAt: number; count: number }>();
  private libraries = new Map<string, StoredLibrary>();
  private syncRows = new Map<string, Map<string, StoredSyncRow>>();
  private syncSeq = new Map<string, number>();

  async getLibrary(id: string): Promise<StoredLibrary | undefined> {
    return this.libraries.get(id);
  }

  async createLibrary(library: StoredLibrary): Promise<boolean> {
    if (this.libraries.has(library.id)) return false;
    this.libraries.set(library.id, library);
    this.syncRows.set(library.id, new Map());
    return true;
  }

  async putRows(libraryId: string, rows: readonly { k: string; c: string }[]): Promise<number> {
    const table = this.syncRows.get(libraryId) ?? new Map<string, StoredSyncRow>();
    this.syncRows.set(libraryId, table);
    let seq = this.syncSeq.get(libraryId) ?? 0;
    for (const row of rows) {
      seq += 1;
      table.set(row.k, { k: row.k, c: row.c, seq });
    }
    this.syncSeq.set(libraryId, seq);
    return seq;
  }

  async changesSince(libraryId: string, since: number, limit: number): Promise<StoredSyncRow[]> {
    return [...(this.syncRows.get(libraryId)?.values() ?? [])]
      .filter((row) => row.seq > since)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async countRows(libraryId: string): Promise<number> {
    return this.syncRows.get(libraryId)?.size ?? 0;
  }

  async deleteLibrary(id: string): Promise<void> {
    this.libraries.delete(id);
    this.syncRows.delete(id);
    this.syncSeq.delete(id);
  }

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
