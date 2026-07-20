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

export function encodeHlc(parts: HlcParts): Hlc {
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

/** The tables that sync — private owned entities and their edges. */
export const SYNCED_TABLES = [
  "places",
  "tags",
  "tagAssignments",
  "notes",
  "mediaAssets",
  "lists",
  "listBlocks",
  "posts",
  "postBlocks",
  "blockNoteAttachments",
  "blockTagSelections",
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
  /** The complete row after this mutation (tombstones carry deleted: true). */
  row: Record<string, unknown>;
}

/** One change streamed from the server; cursor-ordered. */
export interface RemoteChange {
  table: SyncedTable;
  entityId: string;
  hlc: Hlc;
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
    };

export interface MergeContext {
  /** The local row, when one exists. */
  local: Record<string, unknown> | undefined;
  /** The HLC of the last applied/acknowledged revision of this row, if known. */
  localRev: Hlc | undefined;
  /** True when an un-pushed local mutation for this row is still in the outbox. */
  locallyDirty: boolean;
  /** Mints ids for conflict copies. */
  newId: () => string;
  now: string;
}

type PlaceLike = {
  currentOsmRef?: { type: string; id: string };
  osmRefHistory?: { ref: { type: string; id: string }; linkedAt: string; unlinkedAt?: string }[];
  resolutionState?: string;
};

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
  // Older than what we already have — idempotent replays and reordered
  // deliveries drop out here.
  if (context.localRev !== undefined && change.hlc <= context.localRev) return { apply: false };

  const { local } = context;
  if (!local) return { apply: true, row: change.row };

  // Concurrent Markdown edits: the incoming stamp wins the row, the local
  // body survives as a recoverable conflict copy.
  if (
    change.table === "notes" &&
    context.locallyDirty &&
    local.deleted !== true &&
    change.row.deleted !== true &&
    typeof local.body === "string" &&
    typeof change.row.body === "string" &&
    local.body !== change.row.body
  ) {
    const title = typeof local.title === "string" ? local.title : "";
    return {
      apply: true,
      row: change.row,
      conflictCopy: {
        table: "notes",
        row: {
          ...local,
          id: context.newId(),
          title: `(conflict copy) ${title}`.trim(),
          shareable: false,
          createdAt: context.now,
          updatedAt: context.now,
        },
      },
    };
  }

  // Concurrent place relinks: history is append-only from both sides; two
  // sides choosing DIFFERENT current elements is an identity question no
  // clock may answer — the place lands in needs-review for the owner.
  if (change.table === "places" && context.locallyDirty) {
    const incoming = change.row as PlaceLike;
    const existing = local as PlaceLike;
    const localHistory = existing.osmRefHistory ?? [];
    const incomingHistory = incoming.osmRefHistory ?? [];
    const seen = new Set(
      incomingHistory.map((entry) => `${entry.ref.type}/${entry.ref.id}@${entry.linkedAt}`),
    );
    const mergedHistory = [
      ...incomingHistory,
      ...localHistory.filter(
        (entry) => !seen.has(`${entry.ref.type}/${entry.ref.id}@${entry.linkedAt}`),
      ),
    ];
    const conflictingRelink =
      existing.currentOsmRef !== undefined &&
      incoming.currentOsmRef !== undefined &&
      !sameRefLoose(existing.currentOsmRef, incoming.currentOsmRef);
    return {
      apply: true,
      row: {
        ...change.row,
        osmRefHistory: mergedHistory,
        ...(conflictingRelink ? { resolutionState: "needs-review" } : {}),
      },
    };
  }

  return { apply: true, row: change.row };
}
