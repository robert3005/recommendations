/**
 * Postgres adapter (spec/src/tech-stack.md §Sync backend): the deployment
 * store behind the same SyncStorage port the in-memory adapter mirrors.
 * `PgLike` is the minimal parameterized-query surface — node-postgres' Pool
 * satisfies it directly (see OPERATIONS.md for wiring).
 */
import type { Account, ChangeRecord, LoginCode, SyncStorage } from "./storage";

export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PgSyncStorage implements SyncStorage {
  constructor(private readonly db: PgLike) {}

  async putLoginCode(code: LoginCode): Promise<void> {
    await this.db.query(
      `INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET code_hash = $2, expires_at = $3`,
      [code.email, code.codeHash, code.expiresAt],
    );
  }

  async takeLoginCode(email: string): Promise<LoginCode | undefined> {
    const { rows } = await this.db.query(
      "DELETE FROM login_codes WHERE email = $1 RETURNING email, code_hash, expires_at",
      [email],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      email: String(row.email),
      codeHash: String(row.code_hash),
      expiresAt: String(row.expires_at),
    };
  }

  private toAccount(row: Record<string, unknown> | undefined): Account | undefined {
    if (!row) return undefined;
    return {
      id: String(row.id),
      email: String(row.email),
      createdAt: String(row.created_at),
    };
  }

  async findAccountByEmail(email: string): Promise<Account | undefined> {
    const { rows } = await this.db.query("SELECT * FROM accounts WHERE email = $1", [email]);
    return this.toAccount(rows[0]);
  }

  async createAccount(account: Account): Promise<void> {
    await this.db.query("INSERT INTO accounts (id, email, created_at) VALUES ($1, $2, $3)", [
      account.id,
      account.email,
      account.createdAt,
    ]);
  }

  async addAccountToken(accountId: string, tokenHash: string): Promise<void> {
    await this.db.query(
      "INSERT INTO account_tokens (token_hash, account_id, created_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING",
      [tokenHash, accountId],
    );
  }

  async findAccountByTokenHash(tokenHash: string): Promise<Account | undefined> {
    const { rows } = await this.db.query(
      `SELECT a.* FROM accounts a JOIN account_tokens t ON t.account_id = a.id WHERE t.token_hash = $1`,
      [tokenHash],
    );
    return this.toAccount(rows[0]);
  }

  async removeAccountToken(tokenHash: string): Promise<void> {
    await this.db.query("DELETE FROM account_tokens WHERE token_hash = $1", [tokenHash]);
  }

  async removeOtherAccountTokens(accountId: string, retainedTokenHash: string): Promise<void> {
    await this.db.query("DELETE FROM account_tokens WHERE account_id = $1 AND token_hash <> $2", [
      accountId,
      retainedTokenHash,
    ]);
  }

  async appendChange(change: Omit<ChangeRecord, "seq">): Promise<void> {
    // One implicit Postgres transaction owns BOTH operations. The upsert takes
    // a row lock on this account's counter, so concurrent statements receive
    // distinct increasing cursors without depending on a pre-wait snapshot of
    // MAX(seq). A replay is acknowledged by ON CONFLICT; it may consume a
    // harmless cursor gap, but can never append twice or collide with a peer.
    await this.db.query(
      `WITH allocated AS MATERIALIZED (
         INSERT INTO account_cursors (account_id, last_seq)
         VALUES ($1, 1)
         ON CONFLICT (account_id) DO UPDATE
           SET last_seq = account_cursors.last_seq + 1
         RETURNING last_seq
       )
       INSERT INTO changes
         (account_id, seq, mutation_id, actor_id, table_name, entity_id, hlc, version, row, recorded_at)
       SELECT $1, allocated.last_seq, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9
       FROM allocated
       ON CONFLICT (account_id, mutation_id) DO NOTHING`,
      [
        change.accountId,
        change.mutationId,
        change.actorId,
        change.table,
        change.entityId,
        change.hlc,
        JSON.stringify(change.version),
        JSON.stringify(change.row),
        change.recordedAt,
      ],
    );
  }

  async changesSince(accountId: string, after: number, limit: number): Promise<ChangeRecord[]> {
    const { rows } = await this.db.query(
      `SELECT seq, account_id, mutation_id, actor_id, table_name, entity_id, hlc, version, row, recorded_at
       FROM changes WHERE account_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [accountId, after, limit],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      accountId: String(row.account_id),
      mutationId: String(row.mutation_id),
      actorId: String(row.actor_id),
      table: String(row.table_name),
      entityId: String(row.entity_id),
      hlc: String(row.hlc),
      version: (typeof row.version === "string" ? JSON.parse(row.version) : row.version) as Record<
        string,
        number
      >,
      row: (typeof row.row === "string" ? JSON.parse(row.row) : row.row) as Record<string, unknown>,
      recordedAt: String(row.recorded_at),
    }));
  }

  async hit(bucket: string, windowMs: number, now: number): Promise<number> {
    const windowStart = now - (now % windowMs);
    const { rows } = await this.db.query(
      `INSERT INTO rate (bucket, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN rate.window_start = $2 THEN rate.count + 1 ELSE 1 END,
         window_start = $2
       RETURNING count`,
      [bucket, windowStart],
    );
    return Number(rows[0]?.count ?? 1);
  }
}
