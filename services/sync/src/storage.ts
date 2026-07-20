/**
 * Sync-service storage port (spec/src/storage-sync.md §Multi-device sync):
 * per-account append-only change log with a server-monotonic sequence,
 * idempotent mutation ids, and minimal accounts that do nothing but name the
 * sync scope. Postgres in deployment (schema.sql); the in-memory adapter
 * backs tests/dev and mirrors the same semantics.
 */

export interface Account {
  id: string;
  email: string;
  createdAt: string;
}

export interface LoginCode {
  email: string;
  /** SHA-256 hex of the emailed code. */
  codeHash: string;
  expiresAt: string;
}

export interface ChangeRecord {
  /** Server-monotonic per account, from 1. */
  seq: number;
  accountId: string;
  mutationId: string;
  actorId: string;
  table: string;
  entityId: string;
  hlc: string;
  row: Record<string, unknown>;
  recordedAt: string;
}

export interface SyncStorage {
  putLoginCode(code: LoginCode): Promise<void>;
  /** Consumes the code — a login code is single-use. */
  takeLoginCode(email: string): Promise<LoginCode | undefined>;
  findAccountByEmail(email: string): Promise<Account | undefined>;
  createAccount(account: Account): Promise<void>;
  /**
   * Adds a device token to the account — every completed login mints its own
   * bearer, so several devices sync one scope concurrently.
   */
  addAccountToken(accountId: string, tokenHash: string): Promise<void>;
  findAccountByTokenHash(tokenHash: string): Promise<Account | undefined>;
  /** True when the mutation id has already been accepted for this account. */
  hasMutation(accountId: string, mutationId: string): Promise<boolean>;
  /** Appends one change, assigning the next per-account sequence. */
  appendChange(change: Omit<ChangeRecord, "seq">): Promise<ChangeRecord>;
  /** Changes with seq > after, ascending, at most limit. */
  changesSince(accountId: string, after: number, limit: number): Promise<ChangeRecord[]>;
  /** Simple fixed-window rate counter (shared shape with the share service). */
  hit(bucket: string, windowMs: number, now: number): Promise<number>;
}

export class MemorySyncStorage implements SyncStorage {
  private accounts = new Map<string, Account>();
  private tokens = new Map<string, string>(); // tokenHash → accountId
  private codes = new Map<string, LoginCode>();
  private changes = new Map<string, ChangeRecord[]>();
  private mutationIds = new Map<string, Set<string>>();
  private buckets = new Map<string, { windowStart: number; count: number }>();

  async putLoginCode(code: LoginCode): Promise<void> {
    this.codes.set(code.email, code);
  }

  async takeLoginCode(email: string): Promise<LoginCode | undefined> {
    const code = this.codes.get(email);
    this.codes.delete(email);
    return code;
  }

  async findAccountByEmail(email: string): Promise<Account | undefined> {
    return [...this.accounts.values()].find((account) => account.email === email);
  }

  async createAccount(account: Account): Promise<void> {
    this.accounts.set(account.id, account);
  }

  async addAccountToken(accountId: string, tokenHash: string): Promise<void> {
    this.tokens.set(tokenHash, accountId);
  }

  async findAccountByTokenHash(tokenHash: string): Promise<Account | undefined> {
    const accountId = this.tokens.get(tokenHash);
    return accountId ? this.accounts.get(accountId) : undefined;
  }

  async hasMutation(accountId: string, mutationId: string): Promise<boolean> {
    return this.mutationIds.get(accountId)?.has(mutationId) ?? false;
  }

  async appendChange(change: Omit<ChangeRecord, "seq">): Promise<ChangeRecord> {
    const log = this.changes.get(change.accountId) ?? [];
    const record: ChangeRecord = { ...change, seq: log.length + 1 };
    log.push(record);
    this.changes.set(change.accountId, log);
    const ids = this.mutationIds.get(change.accountId) ?? new Set<string>();
    ids.add(change.mutationId);
    this.mutationIds.set(change.accountId, ids);
    return record;
  }

  async changesSince(accountId: string, after: number, limit: number): Promise<ChangeRecord[]> {
    return (this.changes.get(accountId) ?? [])
      .filter((change) => change.seq > after)
      .slice(0, limit);
  }

  async hit(bucket: string, windowMs: number, now: number): Promise<number> {
    const windowStart = now - (now % windowMs);
    const current = this.buckets.get(bucket);
    if (!current || current.windowStart !== windowStart) {
      this.buckets.set(bucket, { windowStart, count: 1 });
      return 1;
    }
    current.count += 1;
    return current.count;
  }
}
