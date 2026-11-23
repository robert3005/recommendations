/**
 * The sync cycle (spec/src/sync.md §The cycle): pull, merge, push.
 *
 *  1. PULL everything the service has after this device's cursor, open each
 *     row, and merge it into the local library in one transaction per page.
 *  2. PUSH every local row whose stamp differs from what this device last
 *     exchanged for it — including deletion markers.
 *
 * Merging happens here, on the device: the service only stores and orders
 * ciphertext. The rules are the pure ones in @placemarks/domain: a row is
 * last-writer-wins by `updatedAt`, a place's own tags merge as a set, and a
 * deletion stands unless the row was edited after it.
 *
 * Nothing is queued. "What is waiting to be sent" is recomputed from the
 * library every cycle, so a cycle that fails half-way loses nothing and the
 * next one simply picks up where the library says things stand.
 */
import {
  compareByRank,
  deletionWins,
  incomingRowWins,
  type ListEntry,
  mergePlace,
  type Place,
  type Post,
  type Publication,
  type SavedView,
  SYNC_TABLES,
  type SyncRecord,
  type SyncTable,
  upgradePlaceStars,
  upgradeViewStars,
} from "@placemarks/domain";
import { SYNC_LIMITS, type SyncRow } from "@placemarks/schemas";
import type { PlacemarksDb } from "../../data/db";
import {
  stripPlaceRow,
  stripPostRow,
  stripPublicationRow,
  toPlaceRow,
  toPostRow,
  toPublicationRow,
  validCoords,
} from "../../data/decisions";
import { type LibraryKeys, open, rowKeyFor, seal } from "./crypto";
import type { SyncTransport } from "./transport";

/** Settings keys. The code is a secret, like a publication's editor token. */
export const SYNC_CODE_KEY = "sync.code";
export const SYNC_CURSOR_KEY = "sync.cursor";
export const SYNC_LAST_AT_KEY = "sync.lastSyncedAt";

export interface SyncSummary {
  /** Rows received from the service. */
  pulled: number;
  /** Of those, how many changed the local library. */
  applied: number;
  /** Rows sent. */
  pushed: number;
}

const rowStamp = (updatedAt: string) => `u:${updatedAt}`;
const deletionStamp = (deletedAt: string) => `d:${deletedAt}`;
const keyOf = (table: SyncTable, id: string) => `${table}:${id}`;

type AnyRow = { id: string; updatedAt: string } & Record<string, unknown>;

/** A stored row as the domain shape that travels: derived index fields removed. */
function outgoing(table: SyncTable, row: AnyRow): AnyRow {
  if (table === "places") return stripPlaceRow(row as never) as unknown as AnyRow;
  if (table === "posts") return stripPostRow(row as never) as unknown as AnyRow;
  if (table === "publications") return stripPublicationRow(row as never) as unknown as AnyRow;
  return row;
}

/** A travelled row as it is stored: derived index fields restored. */
function stored(table: SyncTable, row: AnyRow): AnyRow {
  if (table === "places") return toPlaceRow(row as unknown as Place) as unknown as AnyRow;
  if (table === "posts") return toPostRow(row as unknown as Post) as unknown as AnyRow;
  if (table === "publications") {
    return toPublicationRow(row as unknown as Publication) as unknown as AnyRow;
  }
  return row;
}

/** A row from a device on an older build, in today's shape (five-star ratings). */
function upgraded(table: SyncTable, row: AnyRow): AnyRow {
  if (table === "places") return upgradePlaceStars(row as unknown as Place) as unknown as AnyRow;
  if (table === "views") return upgradeViewStars(row as unknown as SavedView) as unknown as AnyRow;
  return row;
}

/** The least a row must be to be stored — a damaged row is skipped, not written. */
function wellFormed(table: SyncTable, row: Record<string, unknown>): row is AnyRow {
  if (typeof row.id !== "string" || typeof row.updatedAt !== "string") return false;
  if (table === "places") {
    return (
      typeof row.name === "string" &&
      typeof row.lat === "number" &&
      typeof row.lng === "number" &&
      validCoords(row.lat, row.lng)
    );
  }
  if (table === "lists" || table === "views") {
    const marker = row.marker as { shape?: unknown; color?: unknown } | undefined;
    return (
      typeof row.name === "string" &&
      typeof marker?.shape === "string" &&
      typeof marker.color === "string"
    );
  }
  if (table === "listEntries") {
    return (
      typeof row.listId === "string" &&
      typeof row.placeId === "string" &&
      typeof row.rank === "string"
    );
  }
  if (table === "posts") {
    return typeof row.title === "string" && typeof row.body === "string" && row.target != null;
  }
  return typeof row.slug === "string" && row.target != null;
}

function allTables(db: PlacemarksDb) {
  return [
    db.places,
    db.lists,
    db.listEntries,
    db.posts,
    db.publications,
    db.views,
    db.tombstones,
    db.syncState,
  ];
}

/**
 * Merge a page of opened records into the local library, in one transaction.
 * Returns how many changed something. A record that leaves the local library
 * as the answer (the local copy is newer, or a merge produced a third row)
 * deliberately leaves that row's exchange stamp stale, so the push half of
 * the cycle sends the local answer back out.
 */
export async function applyRemote(
  db: PlacemarksDb,
  records: readonly SyncRecord[],
  now: string,
): Promise<number> {
  if (records.length === 0) return 0;
  return db.transaction("rw", allTables(db), async () => {
    let applied = 0;
    for (const record of records) {
      const table = db.table<AnyRow, string>(record.t);
      const key = keyOf(record.t, record.id);
      const local = await table.get(record.id);
      const tombstone = await db.tombstones.get(key);

      if (record.d) {
        if (!deletionWins(record.u, local)) continue; // edited here since: the row stands, and goes back out
        if (local) {
          await table.delete(record.id);
          applied += 1;
        }
        const deletedAt =
          tombstone && tombstone.deletedAt > record.u ? tombstone.deletedAt : record.u;
        await db.tombstones.put({ key, table: record.t, id: record.id, deletedAt });
        // Only when the service's marker IS the local one is there nothing to send.
        if (deletedAt === record.u) await db.syncState.put({ key, stamp: deletionStamp(record.u) });
        continue;
      }

      if (!record.row || !wellFormed(record.t, record.row)) continue;
      const incoming = upgraded(record.t, record.row);
      // Deleted here at or after this version: the deletion stands (and is sent, or was).
      if (tombstone && deletionWins(tombstone.deletedAt, incoming)) continue;

      if (record.t === "places" && local) {
        const outcome = mergePlace(
          stripPlaceRow(local as never),
          incoming as unknown as Place,
          now,
        );
        if (outcome.kind === "local") continue;
        await table.put(stored("places", outcome.place as unknown as AnyRow));
        if (tombstone) await db.tombstones.delete(key);
        applied += 1;
        // An adopted row (even with a richer tag log, the same visible row) is
        // nothing new for the service; a merged row is, so its stamp stays
        // stale and the push half sends it.
        if (outcome.kind === "incoming") {
          await db.syncState.put({ key, stamp: rowStamp(outcome.place.updatedAt) });
        }
        continue;
      }

      if (!incomingRowWins(local, incoming)) continue;
      let next = incoming;
      if (record.t === "publications") {
        // A device that holds a page's editor token never loses it to a copy
        // that does not (spec/src/sharing.md §The editor token).
        const held = (local as { editorToken?: string } | undefined)?.editorToken;
        if (held !== undefined && incoming.editorToken === undefined) {
          next = { ...incoming, editorToken: held };
        }
      }
      await table.put(stored(record.t, next));
      if (tombstone) await db.tombstones.delete(key);
      await db.syncState.put({ key, stamp: rowStamp(incoming.updatedAt) });
      applied += 1;
    }
    return applied;
  });
}

/**
 * Two devices that each put the same place on the same list made two entries.
 * Both collapse them the same deterministic way — the (rank, id)-first entry
 * stays, the rest are deleted with markers — so the devices agree without
 * talking about it.
 */
export async function collapseDuplicateEntries(db: PlacemarksDb, now: string): Promise<number> {
  return db.transaction("rw", [db.listEntries, db.tombstones], async () => {
    const byPair = new Map<string, ListEntry[]>();
    for (const entry of await db.listEntries.toArray()) {
      const pair = `${entry.listId} ${entry.placeId}`;
      byPair.set(pair, [...(byPair.get(pair) ?? []), entry]);
    }
    const extra = [...byPair.values()]
      .filter((group) => group.length > 1)
      .flatMap((group) => [...group].sort(compareByRank).slice(1));
    if (extra.length === 0) return 0;
    await db.tombstones.bulkPut(
      extra.map((entry) => ({
        key: keyOf("listEntries", entry.id),
        table: "listEntries",
        id: entry.id,
        deletedAt: now,
      })),
    );
    await db.listEntries.bulkDelete(extra.map((entry) => entry.id));
    return extra.length;
  });
}

interface Pending {
  key: string;
  stamp: string;
  record: SyncRecord;
}

/** Everything this device has not yet exchanged in its current form. */
export async function collectPending(db: PlacemarksDb): Promise<Pending[]> {
  return db.transaction("r", allTables(db), async () => {
    const exchanged = new Map((await db.syncState.toArray()).map((s) => [s.key, s.stamp]));
    const pending: Pending[] = [];
    // Rows before the entries that point at them, deletions last.
    for (const table of SYNC_TABLES) {
      for (const row of await db.table<AnyRow, string>(table).toArray()) {
        const key = keyOf(table, row.id);
        const stamp = rowStamp(row.updatedAt);
        if (exchanged.get(key) === stamp) continue;
        pending.push({
          key,
          stamp,
          record: { t: table, id: row.id, u: row.updatedAt, row: outgoing(table, row) },
        });
      }
    }
    for (const tombstone of await db.tombstones.toArray()) {
      if (!SYNC_TABLES.includes(tombstone.table as SyncTable)) continue;
      const stamp = deletionStamp(tombstone.deletedAt);
      if (exchanged.get(tombstone.key) === stamp) continue;
      pending.push({
        key: tombstone.key,
        stamp,
        record: {
          t: tombstone.table as SyncTable,
          id: tombstone.id,
          u: tombstone.deletedAt,
          d: true,
        },
      });
    }
    return pending;
  });
}

/** How many rows are waiting to be sent — what the status line and the runner watch. */
export async function pendingCount(db: PlacemarksDb): Promise<number> {
  return (await collectPending(db)).length;
}

async function cursorOf(db: PlacemarksDb): Promise<number> {
  const stored = (await db.settings.get(SYNC_CURSOR_KEY))?.value;
  return typeof stored === "number" && Number.isInteger(stored) && stored >= 0 ? stored : 0;
}

/** One full cycle. Throws a SyncError when the service cannot be reached or refuses. */
export async function syncOnce(
  db: PlacemarksDb,
  keys: LibraryKeys,
  transport: SyncTransport,
  now: () => string,
): Promise<SyncSummary> {
  const summary: SyncSummary = { pulled: 0, applied: 0, pushed: 0 };

  // ---- pull ----
  let cursor = await cursorOf(db);
  for (;;) {
    const page = await transport.pull(cursor);
    const records: SyncRecord[] = [];
    for (const row of page.rows) {
      const record = await open(keys, row.c);
      // The row key is checked too: a row filed under the wrong key is not ours.
      if (record && (await rowKeyFor(keys, record.t, record.id)) === row.k) records.push(record);
    }
    summary.pulled += page.rows.length;
    summary.applied += await applyRemote(db, records, now());
    // The cursor moves only after the page is safely merged.
    cursor = page.cursor;
    await db.settings.put({ key: SYNC_CURSOR_KEY, value: cursor });
    if (!page.more) break;
  }
  await collapseDuplicateEntries(db, now());

  // ---- push ----
  const pending = await collectPending(db);
  for (let i = 0; i < pending.length; i += SYNC_LIMITS.rowsPerPush) {
    const batch = pending.slice(i, i + SYNC_LIMITS.rowsPerPush);
    const rows: SyncRow[] = [];
    for (const item of batch) {
      rows.push({
        k: await rowKeyFor(keys, item.record.t, item.record.id),
        c: await seal(keys, item.record),
      });
    }
    await transport.push(rows);
    // Marked only once the service has them. A row edited again meanwhile has
    // a newer stamp than the one recorded here, so it is simply pending again.
    await db.syncState.bulkPut(batch.map(({ key, stamp }) => ({ key, stamp })));
    summary.pushed += batch.length;
  }

  await db.settings.put({ key: SYNC_LAST_AT_KEY, value: now() });
  return summary;
}

/** Forget what this device exchanged: the next cycle re-reads and re-sends everything. */
export async function resetExchangeState(db: PlacemarksDb): Promise<void> {
  await db.transaction("rw", [db.syncState, db.settings], async () => {
    await db.syncState.clear();
    await db.settings.delete(SYNC_CURSOR_KEY);
    await db.settings.delete(SYNC_LAST_AT_KEY);
  });
}
