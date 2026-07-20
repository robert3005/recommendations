/**
 * The sync engine (spec/src/storage-sync.md §Multi-device sync): a background
 * transport draining the mutation outbox — it never changes local read/write
 * semantics. Push is idempotent (mutation ids), pull applies the server's
 * cursor-ordered change log through the repository's merge policy. A failed
 * network effect never rolls back a committed local edit.
 */
import type { LocalMutation, PullResult, PushResult, SyncTransport } from "@placemarks/domain";
import {
  loginCompleteResponseSchema,
  pullResponseSchema,
  pushResponseSchema,
  SYNC_LIMITS,
} from "@placemarks/schemas";
import { SYNC_API_URL } from "../../config";
import type { SyncStateRow } from "../../data/db";
import type { DexieRepository } from "../../data/repo";

export class HttpSyncTransport implements SyncTransport {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async push(mutations: LocalMutation[]): Promise<PushResult> {
    const response = await this.fetcher(`${SYNC_API_URL}/sync/push`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mutations }),
    });
    if (!response.ok) throw new Error(`push failed (${response.status.toString()})`);
    return pushResponseSchema.parse(await response.json());
  }

  async pull(cursor?: string): Promise<PullResult> {
    const url = new URL(`${SYNC_API_URL}/sync/pull`, window.location.origin);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await this.fetcher(url.toString(), {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`pull failed (${response.status.toString()})`);
    const parsed = pullResponseSchema.parse(await response.json());
    return { changes: parsed.changes, cursor: parsed.cursor };
  }
}

export async function getSyncState(repo: DexieRepository): Promise<SyncStateRow | undefined> {
  return repo.db.syncState.get("sync");
}

/** Request a login code for the address (delivered out of band). */
export async function requestLoginCode(
  email: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${SYNC_API_URL}/sync/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!response.ok)
    throw new Error(`could not request a login code (${response.status.toString()})`);
}

/** Complete the login: the account does nothing but name the sync scope. */
export async function completeLogin(
  repo: DexieRepository,
  email: string,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${SYNC_API_URL}/sync/login/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!response.ok) throw new Error("that code was not accepted — request a fresh one");
  const body = loginCompleteResponseSchema.parse(await response.json());
  const existing = await repo.db.syncState.get("sync");
  await repo.db.syncState.put({
    id: "sync",
    actorId: existing?.actorId ?? repo.actorId,
    accountId: body.accountId,
    token: body.token,
    email,
    // A fresh scope starts from the beginning of the server's log.
    ...(existing?.accountId === body.accountId && existing.cursor
      ? { cursor: existing.cursor }
      : {}),
  });
}

/** Turn sync off: forget the scope; local data and behavior are unchanged. */
export async function signOut(repo: DexieRepository): Promise<void> {
  const existing = await repo.db.syncState.get("sync");
  if (!existing) return;
  await repo.db.syncState.put({ id: "sync", actorId: existing.actorId });
}

export interface SyncOutcome {
  pushed: number;
  applied: number;
}

/** One push + pull round. Throws on network failure — callers surface it. */
export async function syncNow(
  repo: DexieRepository,
  transport?: SyncTransport,
  fetcher: typeof fetch = fetch,
): Promise<SyncOutcome> {
  const state = await repo.db.syncState.get("sync");
  if (!state?.token) return { pushed: 0, applied: 0 };
  const wire = transport ?? new HttpSyncTransport(state.token, fetcher);

  // PUSH — HLC order; acked jobs leave the outbox (idempotent on retry).
  const drainOutbox = async (): Promise<number> => {
    let pushed = 0;
    for (;;) {
      const jobs = (await repo.db.mutationOutbox.toArray())
        .sort((a, b) => (a.hlc < b.hlc ? -1 : 1))
        .slice(0, SYNC_LIMITS.mutationsPerPush);
      if (jobs.length === 0) break;
      const result = await wire.push(
        jobs.map((job) => ({
          id: job.id,
          actorId: job.actorId,
          table: job.table as LocalMutation["table"],
          entityId: job.entityId,
          hlc: job.hlc,
          row: job.row,
        })),
      );
      const acked = new Set(result.acked);
      await repo.db.mutationOutbox.bulkDelete(
        jobs.filter((job) => acked.has(job.id)).map((j) => j.id),
      );
      pushed += acked.size;
      if (jobs.length < SYNC_LIMITS.mutationsPerPush) break;
    }
    return pushed;
  };
  let pushed = await drainOutbox();

  // PULL — cursor loop until the log is drained.
  let applied = 0;
  let cursor = state.cursor;
  for (;;) {
    const page = await wire.pull(cursor);
    if (page.changes.length > 0) {
      await repo.applyRemoteChanges(page.changes);
      applied += page.changes.length;
    }
    cursor = page.cursor;
    if (page.changes.length < SYNC_LIMITS.changesPerPull) break;
  }

  // Applying pulls can mint NEW local content (conflict copies, teardown
  // rescues) — drain again so it reaches the other devices this round.
  pushed += await drainOutbox();

  const latest = (await repo.db.syncState.get("sync")) ?? state;
  await repo.db.syncState.put({
    ...latest,
    cursor,
    lastSyncedAt: new Date().toISOString(),
  });
  return { pushed, applied };
}
