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

/** Bearer credentials and login codes never cross an insecure deployment URL. */
export function assertSecureSyncTransport(): void {
  const fallback = typeof window === "undefined" ? "https://localhost" : window.location.origin;
  let url: URL;
  try {
    url = new URL(SYNC_API_URL || fallback, fallback);
  } catch {
    throw new Error("the sync service URL is invalid");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("the sync service URL is not HTTPS — refusing to send private library data");
  }
}

export class HttpSyncTransport implements SyncTransport {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async push(mutations: LocalMutation[]): Promise<PushResult> {
    assertSecureSyncTransport();
    const body = JSON.stringify({ mutations });
    if (new TextEncoder().encode(body).byteLength > SYNC_LIMITS.requestBytes) {
      throw oversizedMutationError(mutations[0]?.table);
    }
    const response = await this.fetcher(`${SYNC_API_URL}/sync/push`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body,
    });
    if (!response.ok) throw new Error(`push failed (${response.status.toString()})`);
    return pushResponseSchema.parse(await response.json());
  }

  async pull(cursor?: string): Promise<PullResult> {
    assertSecureSyncTransport();
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

/** Serialize the shared IndexedDB sync cursor across tabs/repository instances. */
async function withCrossTabSyncLock<T>(repo: DexieRepository, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return work();
  return locks.request(`placemarks:sync:${repo.db.name}`, work);
}

/** Request a login code for the address (delivered out of band). */
export async function requestLoginCode(
  email: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  assertSecureSyncTransport();
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
  assertSecureSyncTransport();
  const response = await fetcher(`${SYNC_API_URL}/sync/login/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!response.ok) throw new Error("that code was not accepted — request a fresh one");
  const body = loginCompleteResponseSchema.parse(await response.json());
  await withCrossTabSyncLock(repo, async () => {
    const existing = await repo.db.syncState.get("sync");
    await repo.db.syncState.put({
      id: "sync",
      actorId: existing?.actorId ?? repo.actorId,
      ...(existing?.clock ? { clock: existing.clock } : {}),
      ...(existing?.bootstrappedAccountId
        ? { bootstrappedAccountId: existing.bootstrappedAccountId }
        : {}),
      accountId: body.accountId,
      token: body.token,
      email,
      // A fresh scope starts from the beginning of the server's log.
      ...(existing?.accountId === body.accountId && existing.cursor
        ? { cursor: existing.cursor }
        : {}),
    });
    await repo.ensureSyncBootstrap(body.accountId);
  });
}

/** Revoke this device session, then forget its scope; local data is unchanged. */
export async function signOut(repo: DexieRepository, fetcher: typeof fetch = fetch): Promise<void> {
  await withCrossTabSyncLock(repo, async () => {
    const existing = await repo.db.syncState.get("sync");
    if (!existing) return;
    if (existing.token) {
      assertSecureSyncTransport();
      const response = await fetcher(`${SYNC_API_URL}/sync/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${existing.token}` },
      });
      // 401 means the bearer was already absent, which is the desired state.
      if (!response.ok && response.status !== 401) {
        throw new Error(`sign out failed (${response.status.toString()})`);
      }
    }
    await repo.db.transaction("rw", repo.db.syncState, async () => {
      const current = await repo.db.syncState.get("sync");
      if (!current) return;
      // Do not erase credentials from a login that completed while logout was
      // in flight.
      if (current.token !== existing.token || current.accountId !== existing.accountId) return;
      await repo.db.syncState.put({
        id: "sync",
        actorId: current.actorId,
        ...(current.clock ? { clock: current.clock } : {}),
        ...(current.bootstrappedAccountId
          ? { bootstrappedAccountId: current.bootstrappedAccountId }
          : {}),
      });
    });
  });
}

/** Revoke lost/copied bearers while keeping this authenticated device online. */
export async function signOutOtherDevices(
  repo: DexieRepository,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await withCrossTabSyncLock(repo, async () => {
    const state = await repo.db.syncState.get("sync");
    if (!state?.token) throw new Error("sign in before revoking other devices");
    assertSecureSyncTransport();
    const response = await fetcher(`${SYNC_API_URL}/sync/logout/others`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      throw new Error(`signing out other devices failed (${response.status.toString()})`);
    }
  });
}

export interface SyncOutcome {
  pushed: number;
  applied: number;
}

interface SyncScope {
  accountId: string;
  token: string;
}

interface SyncFlight {
  promise: Promise<SyncOutcome>;
  scopeKey: Promise<string>;
}

const syncFlights = new WeakMap<DexieRepository, SyncFlight>();
const utf8 = new TextEncoder();

function sameScope(state: SyncStateRow | undefined, scope: SyncScope): boolean {
  return state?.accountId === scope.accountId && state.token === scope.token;
}

function stateScopeKey(state: SyncStateRow | undefined): string {
  return state?.accountId && state.token ? `${state.accountId}\0${state.token}` : "signed-out";
}

async function assertCurrentScope(repo: DexieRepository, scope: SyncScope): Promise<void> {
  if (!sameScope(await repo.db.syncState.get("sync"), scope)) {
    throw new Error("sync stopped because the signed-in account changed");
  }
}

function toMutation(job: {
  id: string;
  actorId: string;
  table: string;
  entityId: string;
  hlc: string;
  version?: Record<string, number>;
  row: Record<string, unknown>;
}): LocalMutation {
  return {
    id: job.id,
    actorId: job.actorId,
    table: job.table as LocalMutation["table"],
    entityId: job.entityId,
    hlc: job.hlc,
    version: job.version ?? {},
    row: job.row,
  };
}

function oversizedMutationError(table?: LocalMutation["table"]): Error {
  const subject = table === "notes" ? "note" : "library item";
  return new Error(
    `A single queued ${subject} is larger than the 2 MiB sync limit. Shorten it or remove oversized metadata, then try again.`,
  );
}

/** Exact JSON/UTF-8 batching mirrored by the server's request-byte limit. */
export function takePushBatch(mutations: LocalMutation[]): LocalMutation[] {
  const candidates = mutations.slice(0, SYNC_LIMITS.mutationsPerPush);
  const emptyEnvelopeBytes = utf8.encode(JSON.stringify({ mutations: [] })).byteLength;
  let bytes = emptyEnvelopeBytes;
  const batch: LocalMutation[] = [];
  for (const mutation of candidates) {
    const mutationBytes = utf8.encode(JSON.stringify(mutation)).byteLength;
    const nextBytes = bytes + mutationBytes + (batch.length > 0 ? 1 : 0);
    if (nextBytes > SYNC_LIMITS.requestBytes) {
      if (batch.length === 0) throw oversizedMutationError(mutation.table);
      break;
    }
    batch.push(mutation);
    bytes = nextBytes;
  }
  return batch;
}

function sanitizedSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^(push|pull) failed \(\d{3}\)$/.test(message)) return message;
  if (/^A single queued (note|library item) is larger than the 2 MiB sync limit\./.test(message)) {
    return message;
  }
  if (message === "sync service acknowledged no queued changes") return message;
  if (message === "sync stopped because the signed-in account changed") return message;
  return "Sync failed. Check your connection and try again.";
}

async function persistSyncFailure(
  repo: DexieRepository,
  scope: SyncScope,
  error: unknown,
): Promise<void> {
  await repo.db.transaction("rw", repo.db.syncState, async () => {
    const state = await repo.db.syncState.get("sync");
    if (!sameScope(state, scope) || !state) return;
    await repo.db.syncState.put({ ...state, lastError: sanitizedSyncError(error) });
  });
}

/** One push + pull round for a captured account/token scope. */
async function runSyncNow(
  repo: DexieRepository,
  initialState: SyncStateRow | undefined,
  transport?: SyncTransport,
  fetcher: typeof fetch = fetch,
): Promise<SyncOutcome> {
  let state = initialState;
  if (!state?.token) return { pushed: 0, applied: 0 };
  if (!state.accountId) throw new Error("signed-in sync state is missing its account scope");
  const scope: SyncScope = { accountId: state.accountId, token: state.token };

  try {
    assertSecureSyncTransport();
    await repo.ensureSyncBootstrap(scope.accountId);
    await assertCurrentScope(repo, scope);
    state = (await repo.db.syncState.get("sync")) ?? state;
    const wire = transport ?? new HttpSyncTransport(scope.token, fetcher);

    // PUSH — HLC order; acked jobs leave the outbox (idempotent on retry).
    const drainOutbox = async (): Promise<number> => {
      let pushed = 0;
      for (;;) {
        await assertCurrentScope(repo, scope);
        const jobs = (await repo.db.mutationOutbox.toArray()).sort((a, b) =>
          a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        if (jobs.length === 0) break;
        const batch = takePushBatch(jobs.map(toMutation));
        const batchIds = new Set(batch.map((mutation) => mutation.id));
        const result = await wire.push(batch);
        const acked = new Set(result.acked.filter((id) => batchIds.has(id)));
        if (acked.size === 0) throw new Error("sync service acknowledged no queued changes");
        await repo.db.transaction("rw", [repo.db.syncState, repo.db.mutationOutbox], async () => {
          const current = await repo.db.syncState.get("sync");
          if (!sameScope(current, scope)) {
            throw new Error("sync stopped because the signed-in account changed");
          }
          await repo.db.mutationOutbox.bulkDelete([...acked]);
        });
        pushed += acked.size;
      }
      return pushed;
    };
    let pushed = await drainOutbox();

    // PULL — cursor loop until the log is drained.
    let applied = 0;
    let remoteChanged = false;
    let cursor = state.cursor;
    for (;;) {
      await assertCurrentScope(repo, scope);
      const page = await wire.pull(cursor);
      await assertCurrentScope(repo, scope);
      if (page.changes.length === 0) {
        cursor = page.cursor;
        break;
      }
      if (page.cursor === cursor) {
        throw new Error("sync pull returned changes without advancing its cursor");
      }
      // A valid dependency chain can cross the page boundary, so graph repair
      // runs once at the final cursor rather than treating an intermediate
      // page as the complete library.
      remoteChanged =
        (await repo.applyRemoteChanges(page.changes, {
          repairGraph: false,
          expectedScope: scope,
        })) || remoteChanged;
      applied += page.changes.length;
      cursor = page.cursor;
    }
    if (applied > 0) {
      await repo.repairSyncedGraph({ publicationImpact: remoteChanged, expectedScope: scope });
    }

    // Applying pulls can mint NEW local content (conflict copies, teardown
    // rescues) — drain again so it reaches the other devices this round.
    pushed += await drainOutbox();

    await repo.db.transaction("rw", repo.db.syncState, async () => {
      const latest = await repo.db.syncState.get("sync");
      if (!sameScope(latest, scope) || !latest) {
        throw new Error("sync stopped because the signed-in account changed");
      }
      await repo.db.syncState.put({
        ...latest,
        cursor,
        ...(repo.currentHlc() ? { clock: repo.currentHlc() } : {}),
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      });
    });
    return { pushed, applied };
  } catch (error) {
    await persistSyncFailure(repo, scope, error).catch(() => undefined);
    throw error;
  }
}

/** Coalesce concurrent triggers into one flight per repository instance. */
export function syncNow(
  repo: DexieRepository,
  transport?: SyncTransport,
  fetcher: typeof fetch = fetch,
): Promise<SyncOutcome> {
  const existing = syncFlights.get(repo);
  if (existing) {
    // Same-scope triggers share the active request. A login/account switch
    // waits for the old flight to observe cancellation, then starts a fresh
    // flight with the new bearer instead of returning the stale result.
    return Promise.all([repo.db.syncState.get("sync"), existing.scopeKey]).then(
      async ([state, activeScope]) => {
        if (stateScopeKey(state) === activeScope) return existing.promise;
        await existing.promise.catch(() => undefined);
        return syncNow(repo, transport, fetcher);
      },
    );
  }
  const statePromise = repo.db.syncState.get("sync");
  const scopeKey = statePromise.then(stateScopeKey);
  const run = statePromise.then((state) =>
    withCrossTabSyncLock(repo, () => runSyncNow(repo, state, transport, fetcher)),
  );
  const flight = run.finally(() => {
    if (syncFlights.get(repo)?.promise === flight) syncFlights.delete(repo);
  });
  syncFlights.set(repo, { promise: flight, scopeKey });
  return flight;
}
