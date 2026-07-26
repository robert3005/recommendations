/**
 * Multi-device sync primitives (spec/src/storage-sync.md §Multi-device sync):
 * every mutation has a globally unique id, actor id, entity id, and a
 * deterministic revision stamp — a hybrid logical clock. Client wall clocks
 * are display metadata, never the conflict order. Push is idempotent; pull
 * uses a server-monotonic cursor; entities and edges merge independently with
 * tombstone acknowledgement.
 */

/**
 * A hybrid logical clock stamp, encoded sortable: zero-padded milliseconds,
 * a hex counter for same-millisecond causality, and the actor id as the
 * total-order tiebreaker. String comparison IS the causal/arbitration order.
 */
export type Hlc = string;

export interface HlcParts {
  millis: number;
  counter: number;
  actorId: string;
}

const MILLIS_DIGITS = 15;
const COUNTER_DIGITS = 6;
const MAX_HLC_MILLIS = 10 ** MILLIS_DIGITS - 1;
const MAX_HLC_COUNTER = 16 ** COUNTER_DIGITS - 1;

export function encodeHlc(parts: HlcParts): Hlc {
  if (
    !Number.isSafeInteger(parts.millis) ||
    parts.millis < 0 ||
    parts.millis > MAX_HLC_MILLIS ||
    !Number.isSafeInteger(parts.counter) ||
    parts.counter < 0 ||
    parts.counter > MAX_HLC_COUNTER ||
    parts.actorId.length === 0
  ) {
    throw new Error("hybrid logical clock parts are outside the representable range");
  }
  return [
    parts.millis.toString().padStart(MILLIS_DIGITS, "0"),
    parts.counter.toString(16).padStart(COUNTER_DIGITS, "0"),
    parts.actorId,
  ].join(":");
}

export function decodeHlc(hlc: Hlc): HlcParts {
  const [millis = "0", counter = "0", ...actor] = hlc.split(":");
  return {
    millis: Number.parseInt(millis, 10),
    counter: Number.parseInt(counter, 16),
    actorId: actor.join(":"),
  };
}

/** The next stamp for a local event: monotonic even against a stalled wall clock. */
export function tickHlc(previous: Hlc | undefined, wallMillis: number, actorId: string): Hlc {
  if (!previous) return encodeHlc({ millis: wallMillis, counter: 0, actorId });
  const last = decodeHlc(previous);
  if (wallMillis > last.millis) return encodeHlc({ millis: wallMillis, counter: 0, actorId });
  if (last.counter === MAX_HLC_COUNTER) {
    if (last.millis === MAX_HLC_MILLIS) {
      throw new Error("hybrid logical clock has no representable successor");
    }
    return encodeHlc({ millis: last.millis + 1, counter: 0, actorId });
  }
  return encodeHlc({ millis: last.millis, counter: last.counter + 1, actorId });
}

/**
 * Witnessing a remote stamp advances the local clock so later local events
 * sort after everything already observed.
 */
export function mergeHlc(
  local: Hlc | undefined,
  observed: Hlc,
  wallMillis: number,
  actorId: string,
): Hlc {
  const base = local && local > observed ? local : observed;
  return tickHlc(base, wallMillis, actorId);
}

/**
 * Per-entity causal context. HLC provides a deterministic total-order winner;
 * this bounded device vector tells a causal successor from a genuinely
 * concurrent edit, which a timestamp alone cannot do.
 */
export type VersionVector = Record<string, number>;

export type VersionRelation = "equal" | "before" | "after" | "concurrent";

function assertVersionEntry(actorId: string, counter: number): void {
  if (
    actorId.length === 0 ||
    actorId.length > 80 ||
    !Number.isSafeInteger(counter) ||
    counter <= 0
  ) {
    throw new Error("version-vector entry is outside the representable range");
  }
}

export function mergeVersionVectors(
  left: VersionVector | undefined,
  right: VersionVector | undefined,
): VersionVector {
  const merged: VersionVector = {};
  for (const [actorId, counter] of Object.entries(left ?? {})) {
    assertVersionEntry(actorId, counter);
    merged[actorId] = counter;
  }
  for (const [actorId, counter] of Object.entries(right ?? {})) {
    assertVersionEntry(actorId, counter);
    if (counter > (merged[actorId] ?? 0)) merged[actorId] = counter;
  }
  return merged;
}

export function incrementVersionVector(
  version: VersionVector | undefined,
  actorId: string,
): VersionVector {
  if (actorId.length === 0 || actorId.length > 80) {
    throw new Error("a version-vector actor id is outside the representable range");
  }
  const next = mergeVersionVectors(version, undefined);
  const previous = next[actorId] ?? 0;
  if (previous === Number.MAX_SAFE_INTEGER) {
    throw new Error("version-vector counter has no representable successor");
  }
  next[actorId] = previous + 1;
  return next;
}

export function compareVersionVectors(
  left: VersionVector | undefined,
  right: VersionVector | undefined,
): VersionRelation {
  let leftAhead = false;
  let rightAhead = false;
  const actors = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  for (const actorId of actors) {
    const l = left?.[actorId] ?? 0;
    const r = right?.[actorId] ?? 0;
    if (l > r) leftAhead = true;
    if (r > l) rightAhead = true;
  }
  if (leftAhead && rightAhead) return "concurrent";
  if (leftAhead) return "after";
  if (rightAhead) return "before";
  return "equal";
}

/** The tables that sync — private owned entities and their edges. */
export const SYNCED_TABLES = [
  "places",
  "tags",
  "tagAssignments",
  "notes",
  "lists",
  "listBlocks",
  "posts",
  "postBlocks",
  "blockNoteAttachments",
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

export function isSyncedTable(value: string): value is SyncedTable {
  return (SYNCED_TABLES as readonly string[]).includes(value);
}

/**
 * One durable local mutation, drained by the sync transport. Carries the full
 * row snapshot: per-entity/edge state replication ordered by HLC, so
 * concurrent changes to different rows never replace a whole list or post.
 */
export interface LocalMutation {
  /** Globally unique — doubles as the push idempotency identity. */
  id: string;
  actorId: string;
  table: SyncedTable;
  entityId: string;
  /** Deterministic revision stamp — the conflict order. */
  hlc: Hlc;
  /** Per-entity causal context; optional only for pre-vector queued mutations. */
  version?: VersionVector;
  /** The complete row after this mutation (tombstones carry deleted: true). */
  row: Record<string, unknown>;
}

/** One change streamed from the server; cursor-ordered. */
export interface RemoteChange {
  table: SyncedTable;
  entityId: string;
  hlc: Hlc;
  /** Per-entity causal context; absent only on legacy server records. */
  version?: VersionVector;
  actorId: string;
  row: Record<string, unknown>;
}

export interface PushResult {
  /** Mutation ids the server has durably accepted (idempotent re-push safe). */
  acked: string[];
}

export interface PullResult {
  changes: RemoteChange[];
  /** Server-monotonic cursor — hand it back on the next pull. */
  cursor: string;
  /**
   * Rows this page carried that could not be read. They are skipped so the
   * cursor can advance; the caller preserves them for inspection rather than
   * letting one malformed row wedge the account's pull forever.
   */
  unreadable?: { raw: string; reason: string }[];
}

/** The transport contract (spec/src/architecture.md §External service adapters). */
export interface SyncTransport {
  push(mutations: LocalMutation[]): Promise<PushResult>;
  pull(cursor?: string): Promise<PullResult>;
}

/** How an incoming remote row must be applied locally. */
export type MergeDecision =
  | { apply: false }
  | {
      apply: true;
      /**
       * A concurrent local Markdown edit is preserved as a recoverable
       * conflict copy rather than silently losing to last-writer-wins
       * (spec/src/storage-sync.md).
       */
      conflictCopy?: { table: SyncedTable; row: Record<string, unknown> };
      /** The row to write — possibly adjusted by conservative place merging. */
      row: Record<string, unknown>;
      /** Emit a new mutation whose vector dominates both competing inputs. */
      reconcile?: boolean;
      /** Metadata-only merge when concurrent snapshots are byte-equivalent. */
      rowChanged?: boolean;
      /** Causal context learned without creating another semantic mutation. */
      observedVersion?: VersionVector;
      /** Total-order checkpoint paired with observedVersion. */
      observedRev?: Hlc;
    };

export interface MergeContext {
  /** The local row, when one exists. */
  local: Record<string, unknown> | undefined;
  /** The HLC of the last applied/acknowledged revision of this row, if known. */
  localRev: Hlc | undefined;
  /** The local row's causal context. */
  localVersion?: VersionVector;
  /** Legacy fallback for revisions written before version vectors existed. */
  locallyDirty?: boolean;
  /** Mints ids for conflict copies. */
  newId: () => string;
  now: string;
}

type PlaceLike = {
  currentOsmRef?: { type: string; id: string };
  currentOsmLinkedAt?: string;
  updatedAt?: string;
  osmRefHistory?: {
    ref: { type: string; id: string };
    linkedAt: string;
    unlinkedAt?: string;
    reason?: string;
  }[];
  resolutionState?: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** A compact deterministic id; four independently seeded 32-bit hashes. */
function stableConflictId(source: unknown): string {
  const input = stableJson(source);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const digest = seeds.map((seed) => {
    let hash = seed;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
      hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  });
  return `conflict-note-${digest.join("")}`;
}

function sourceTimestamp(row: Record<string, unknown>, hlc: Hlc): string {
  if (typeof row.updatedAt === "string") return row.updatedAt;
  if (typeof row.createdAt === "string") return row.createdAt;
  return new Date(decodeHlc(hlc).millis).toISOString();
}

function placeHistoryKey(entry: NonNullable<PlaceLike["osmRefHistory"]>[number]): string {
  return `${entry.linkedAt}\0${entry.unlinkedAt ?? ""}\0${entry.ref.type}/${entry.ref.id}\0${entry.reason ?? ""}`;
}

const sameRefLoose = (
  a: { type: string; id: string } | undefined,
  b: { type: string; id: string } | undefined,
): boolean => a?.type === b?.type && a?.id === b?.id;

/**
 * Decide how an incoming change lands (spec/src/storage-sync.md §Multi-device
 * sync): per-row last-writer-wins by HLC, except —
 *  - concurrent Markdown edits keep both bodies (conflict copy);
 *  - concurrent place relinks merge append-only history conservatively, and
 *    conflicting candidate choices become `needs-review`.
 */
export function mergeRemoteChange(change: RemoteChange, context: MergeContext): MergeDecision {
  const { local } = context;
  if (!local) return { apply: true, row: change.row };

  const localVersion = context.localVersion ?? {};
  const incomingVersion = change.version ?? {};
  const vectorAware =
    Object.keys(localVersion).length > 0 && Object.keys(incomingVersion).length > 0;
  const relation = compareVersionVectors(localVersion, incomingVersion);
  if (vectorAware) {
    if (relation === "after") return { apply: false };
    if (relation === "equal") {
      if (context.localRev !== undefined && change.hlc <= context.localRev) return { apply: false };
      return { apply: true, row: change.row };
    }
    if (relation === "before") return { apply: true, row: change.row };
  } else if (
    context.localRev !== undefined &&
    change.hlc <= context.localRev &&
    context.locallyDirty !== true
  ) {
    // Compatibility for rows and pending mutations created before causal
    // vectors were introduced.
    return { apply: false };
  }

  const concurrent = vectorAware ? relation === "concurrent" : context.locallyDirty === true;
  if (!concurrent) return { apply: true, row: change.row };
  const incomingWins = context.localRev === undefined || change.hlc > context.localRev;

  // The same deterministic snapshot can be authored independently (notably a
  // note conflict copy). Merge only its causal metadata locally; emitting a
  // fresh descendant on every receiver would create an endless ping-pong.
  if (stableJson(local) === stableJson(change.row)) {
    return {
      apply: true,
      row: incomingWins ? change.row : local,
      rowChanged: false,
      observedVersion: mergeVersionVectors(localVersion, incomingVersion),
      observedRev:
        context.localRev && context.localRev > change.hlc ? context.localRev : change.hlc,
    };
  }

  // Concurrent Markdown edits: the incoming stamp wins the row, the local
  // body survives as a recoverable conflict copy. This deliberately includes
  // an incoming NOTE TOMBSTONE: teardown is authored bottom-up, so the copy is
  // still live when the later target tombstone arrives and can be rescued into
  // the owner's conflict surface instead of silently losing its Markdown.
  if (
    change.table === "notes" &&
    concurrent &&
    typeof local.body === "string" &&
    typeof change.row.body === "string" &&
    (local.deleted === true || change.row.deleted === true || local.body !== change.row.body)
  ) {
    const winner = incomingWins ? change.row : local;
    const loser = incomingWins ? local : change.row;
    const losingRev = incomingWins ? (context.localRev ?? change.hlc) : change.hlc;
    const title = typeof loser.title === "string" ? loser.title : "";
    const preserveLoser = loser.deleted !== true;
    const { deleted: _deleted, id: _id, targetKey: _targetKey, ...portableLoser } = loser;
    const copyTimestamp = sourceTimestamp(loser, losingRev);
    const copyId = stableConflictId({
      entityId: change.entityId,
      losingRev,
      row: portableLoser,
    });
    return {
      apply: true,
      row: winner,
      reconcile: true,
      ...(preserveLoser
        ? {
            conflictCopy: {
              table: "notes" as const,
              row: {
                ...portableLoser,
                id: copyId,
                title: `(conflict copy) ${title}`.trim(),
                shareable: false,
                createdAt: copyTimestamp,
                updatedAt: copyTimestamp,
              },
            },
          }
        : {}),
    };
  }

  // Concurrent place relinks: history is append-only from both sides; two
  // sides choosing DIFFERENT current elements is an identity question no
  // clock may answer — the place lands in needs-review for the owner.
  if (change.table === "places") {
    const incoming = change.row as PlaceLike;
    const existing = local as PlaceLike;
    const winner = (incomingWins ? change.row : local) as PlaceLike & Record<string, unknown>;
    const loser = (incomingWins ? local : change.row) as PlaceLike;
    const localHistory = existing.osmRefHistory ?? [];
    const incomingHistory = incoming.osmRefHistory ?? [];
    const historyByKey = new Map(
      [...localHistory, ...incomingHistory].map((entry) => [placeHistoryKey(entry), entry]),
    );
    const conflictingRelink =
      existing.currentOsmRef !== undefined &&
      incoming.currentOsmRef !== undefined &&
      !sameRefLoose(existing.currentOsmRef, incoming.currentOsmRef);
    if (conflictingRelink && loser.currentOsmRef) {
      const losingRev = incomingWins ? (context.localRev ?? change.hlc) : change.hlc;
      const completed = {
        ref: loser.currentOsmRef,
        linkedAt:
          loser.currentOsmLinkedAt ??
          loser.updatedAt ??
          sourceTimestamp(loser as Record<string, unknown>, losingRev),
        unlinkedAt: sourceTimestamp(loser as Record<string, unknown>, losingRev),
        reason: "merged" as const,
      };
      historyByKey.set(placeHistoryKey(completed), completed);
    }
    const mergedHistory = [...historyByKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry);
    return {
      apply: true,
      row: {
        ...winner,
        osmRefHistory: mergedHistory,
        ...(conflictingRelink ? { resolutionState: "needs-review" } : {}),
      },
      reconcile: true,
    };
  }

  // Concurrent scalar/edge changes still need one descendant revision so a
  // fresh device sees a resolved causal frontier instead of replaying the race.
  return { apply: true, row: incomingWins ? change.row : local, reconcile: true };
}
