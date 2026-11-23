/**
 * Merging two devices' copies of a library (spec/src/sync.md §Merging), as
 * pure functions. Two rules:
 *
 *  - a row is last-writer-wins by `updatedAt` — the same rule the archive
 *    restore already uses;
 *  - a place's own TAGS are the exception: they merge as a set, tag by tag,
 *    so a tag added on the phone and another added on the laptop both
 *    survive, and a removal on one device is not undone by an older copy on
 *    the other.
 *
 * Deletions travel as markers ("tombstones"), compared against a row's
 * `updatedAt` the same way: whichever happened later stands.
 */
import type { Place } from "./entities";
import { stableStringify } from "./projection";

/** The stores that sync. Import working state and settings stay on the device. */
export const SYNC_TABLES = [
  "places",
  "lists",
  "listEntries",
  "posts",
  "publications",
  "views",
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/** What a device encrypts and sends: a row, or the marker that it was deleted. */
export interface SyncRecord {
  t: SyncTable;
  id: string;
  /** The row's `updatedAt`, or the deletion time when `d` is set. */
  u: string;
  /** Deleted. */
  d?: true;
  /** The row itself; absent on a deletion marker. */
  row?: Record<string, unknown>;
}

/** When each own tag was last put on or taken off — what makes tags merge as a set. */
export type TagLog = Record<string, { at: string; on: boolean }>;

/**
 * A place's tag log, complete: a tag with no entry (a place tagged before
 * logs existed, or restored from an old archive) counts as put on when the
 * place was last updated.
 */
export function effectiveTagLog(place: Pick<Place, "tags" | "tagLog" | "updatedAt">): TagLog {
  const log: TagLog = { ...(place.tagLog ?? {}) };
  for (const tag of place.tags ?? []) {
    if (log[tag]?.on !== true) log[tag] = { at: place.updatedAt, on: true };
  }
  return log;
}

/** The log after an edit: every tag added or removed is stamped `at`. */
export function logTagChange(
  place: Pick<Place, "tags" | "tagLog" | "updatedAt">,
  nextTags: readonly string[],
  at: string,
): TagLog {
  const log = effectiveTagLog(place);
  const next = new Set(nextTags);
  const previous = new Set(place.tags ?? []);
  for (const tag of next) if (!previous.has(tag)) log[tag] = { at, on: true };
  for (const tag of previous) if (!next.has(tag)) log[tag] = { at, on: false };
  return log;
}

/** Per tag, the later stamp stands; on an exact tie, the tag stays on. */
export function mergeTagLogs(a: TagLog, b: TagLog): TagLog {
  const merged: TagLog = { ...a };
  for (const [tag, entry] of Object.entries(b)) {
    const mine = merged[tag];
    if (!mine || entry.at > mine.at || (entry.at === mine.at && entry.on && !mine.on)) {
      merged[tag] = entry;
    }
  }
  return merged;
}

export function tagsOf(log: TagLog): string[] {
  return Object.entries(log)
    .filter(([, entry]) => entry.on)
    .map(([tag]) => tag)
    .sort();
}

const sameTags = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  (a ?? []).length === b.length && (a ?? []).every((tag, i) => tag === b[i]);

const sameLog = (a: TagLog | undefined, b: TagLog): boolean => {
  const keys = Object.keys(b);
  if (Object.keys(a ?? {}).length !== keys.length) return false;
  return keys.every((k) => a?.[k]?.at === b[k]?.at && a?.[k]?.on === b[k]?.on);
};

/** A time strictly after both rows, so a merged row out-ranks its two sources everywhere. */
function after(now: string, a: string, b: string): string {
  const latest = a > b ? a : b;
  if (now > latest) return now;
  return new Date(Date.parse(latest) + 1).toISOString();
}

export type MergeOutcome =
  /** The local row stands; nothing to write. */
  | { kind: "local" }
  /** The incoming row stands exactly as sent. */
  | { kind: "incoming"; place: Place }
  /** Neither copy is the answer: write this one, and send it back out. */
  | { kind: "merged"; place: Place };

/**
 * Merge an incoming copy of a place into the local one. Every field but the
 * tags comes from whichever copy was updated later; the tags are the union
 * of what each device did to them.
 */
export function mergePlace(local: Place, incoming: Place, now: string): MergeOutcome {
  const log = mergeTagLogs(effectiveTagLog(local), effectiveTagLog(incoming));
  const tags = tagsOf(log);
  const incomingNewer = incomingRowWins(local, incoming);
  const base = incomingNewer ? incoming : local;

  if (sameTags(base.tags, tags) && sameLog(base.tagLog, log)) {
    return incomingNewer ? { kind: "incoming", place: incoming } : { kind: "local" };
  }
  // The log grew but the visible tags did not change: adopt the richer log
  // quietly on the newer copy — no new edit to announce.
  if (sameTags(base.tags, tags) && sameTags(local.tags, tags) && sameTags(incoming.tags, tags)) {
    const { tags: _tags, tagLog: _log, ...rest } = base;
    const place: Place = { ...rest, ...(tags.length > 0 ? { tags } : {}), tagLog: log };
    return incomingNewer ? { kind: "incoming", place } : { kind: "local" };
  }
  const { tags: _tags, tagLog: _log, ...rest } = base;
  return {
    kind: "merged",
    place: {
      ...rest,
      ...(tags.length > 0 ? { tags } : {}),
      tagLog: log,
      updatedAt: after(now, local.updatedAt, incoming.updatedAt),
    },
  };
}

/**
 * Last writer wins: does the incoming row replace the local one? Two
 * different rows stamped the very same instant have no later writer, so the
 * tie is broken by their content — arbitrary, but the same on every device,
 * which is what keeps two devices from each holding on to their own copy
 * forever.
 */
export function incomingRowWins(
  local: { updatedAt: string } | undefined,
  incoming: { updatedAt: string },
): boolean {
  if (local === undefined) return true;
  if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt;
  return stableStringify(incoming) > stableStringify(local);
}

/** A deletion stands against a row unless the row was updated after it. */
export function deletionWins(deletedAt: string, row: { updatedAt: string } | undefined): boolean {
  return row === undefined || row.updatedAt <= deletedAt;
}
