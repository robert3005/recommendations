/**
 * Dexie schema — the durable primary store (spec/src/storage-sync.md).
 * Rows carry derived index fields (refKeys, targetKey, kind/refId) next to the
 * domain shape; the repository strips/derives them at the boundary.
 *
 * One version. Nothing has shipped, so there is no database anywhere that
 * predates this schema and no migration to carry.
 */
import type {
  BlockNoteAttachment,
  EditorCredential,
  List,
  ListBlock,
  MediaAsset,
  Note,
  Place,
  Post,
  PostBlock,
  Publication,
  Tag,
  TagAssignment,
  VersionVector,
} from "@placemarks/domain";
import Dexie, { type EntityTable } from "dexie";

export type PlaceRow = Place & { refKeys: string[] };
export type NoteRow = Note & { targetKey: string };
/**
 * List blocks carry membership only since the 2026-07-19 pivot; tombstoned
 * pre-pivot section rows remain in the table, so the row type still names them.
 */
export type ListBlockRow = Omit<ListBlock, "content"> & {
  kind: "section" | "place";
  refId: string;
  content: { type: "place"; placeId: string } | { type: "section"; noteId: string };
};
export type PostBlockRow = PostBlock & { kind: "section" | "place"; refId: string };
export interface MediaBlobRow {
  id: string;
  blob: Blob;
}

/**
 * Import workflow state (spec/src/interop.md §Import queue model): persisted so
 * a half-reviewed import survives a reload; not part of the durable place graph.
 */
export interface ImportBatchRow {
  id: string;
  source: "google-takeout" | "csv" | "kml" | "gpx" | "geojson";
  fileName: string;
  startedAt: string;
  status: "reviewing" | "done" | "abandoned";
}

/** Source-list identity: re-imports target the same local list even after a rename. */
export interface ImportSourceRow {
  sourceKey: string;
  listId: string;
}

/**
 * One durable local mutation awaiting the sync transport
 * (spec/src/storage-sync.md §Multi-device sync): globally unique id, actor,
 * entity, HLC revision stamp, and the full row snapshot. Logged in the SAME
 * transaction as the write it records.
 */
export interface MutationRow {
  id: string;
  actorId: string;
  table: string;
  entityId: string;
  hlc: string;
  /** Per-entity causal context; absent only on pre-vector queued rows. */
  version?: VersionVector;
  row: Record<string, unknown>;
  createdAt: string;
}

/** Device-scoped sync state: account, cursor, clock — never part of backups. */
export interface SyncStateRow {
  id: "sync";
  actorId: string;
  /** Durable checkpoint for the device HLC; syncRevs is the crash-safe fallback. */
  clock?: string;
  accountId?: string;
  /** Bearer token naming the sync scope; never in any public document. */
  token?: string;
  email?: string;
  cursor?: string;
  lastSyncedAt?: string;
  lastError?: string;
  /** Scope for which the pre-sync local library has been snapshotted once. */
  bootstrappedAccountId?: string;
}

/**
 * entityKey (`table:id`) → the row's latest known revision stamp, and whether
 * it came from THIS device ("local") or was applied from the server
 * ("remote") — the signal that an incoming newer edit was CONCURRENT with an
 * unobserved local one (conflict-copy territory), not a causal successor.
 */
export interface SyncRevRow {
  key: string;
  hlc: string;
  /** Per-entity causal context; absent only on pre-vector revision rows. */
  version?: VersionVector;
  origin: "local" | "remote";
}

/**
 * Rescued content a sync interleaving orphaned (e.g. a note edit racing its
 * target's teardown) — recoverable, never silently dropped.
 */
export interface SyncConflictRow {
  id: string;
  kind: "orphaned-note" | "unreadable-row";
  title?: string;
  body: string;
  reason: string;
  at: string;
}

/** One durable publish/revoke job (spec/src/sharing.md §Local publication record). */
export interface PublicationJob {
  /** Doubles as the Idempotency-Key; a retry reuses it. */
  key: string;
  /** The exact serialized document this job publishes (captured at enqueue). */
  payload?: string;
  /** The content hash this job projects — completing an older job never rolls state back. */
  hash?: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

/**
 * One row per publication, keyed by it. At most one pending publish and one
 * pending revoke, which makes precedence STRUCTURAL rather than a scan:
 * scheduling a revoke drops the pending publish, scheduling a publish never
 * drops a pending revoke, and the drain always takes the revoke first. A failed
 * draft publish therefore cannot strand an unpublish
 * (spec/src/sharing.md §Failure isolation and revocation precedence).
 *
 * Local-only: publication state and its credential never leave the device.
 */
export interface PublicationJobsRow {
  publicationId: string;
  publish?: PublicationJob;
  revoke?: PublicationJob;
}

export interface ImportItemRow {
  id: string;
  batchId: string;
  targetListId: string;
  raw: {
    title: string;
    note?: string;
    url?: string;
    urls?: string[];
    address?: string;
    category?: string;
    website?: string;
    phone?: string;
    openingHours?: string;
    tags?: string[];
    osmRef?: { type: "node" | "way" | "relation"; id: string };
    /** A pending shared-guide anchor keeps its complete recovery envelope. */
    sharedAnchor?: unknown;
    /** Every selected shared note (title + body) travels with the pending row. */
    sharedNotes?: { title?: string; body: string }[];
  };
  coords?: { lat: number; lng: number };
  /** Geocode candidates awaiting review (typed OSM refs from the search adapter). */
  candidates?: {
    ref: { type: "node" | "way" | "relation"; id: string };
    name: string;
    lat: number;
    lng: number;
    category?: string;
    address?: string;
  }[];
  status: "placed" | "review" | "skipped" | "duplicate";
  /** True when the placed item was OSM-linked at import time. */
  linkedOsm?: boolean;
  placeId?: string;
}

export class PlacemarksDb extends Dexie {
  places!: EntityTable<PlaceRow, "id">;
  tags!: EntityTable<Tag, "id">;
  tagAssignments!: EntityTable<TagAssignment, "id">;
  notes!: EntityTable<NoteRow, "id">;
  mediaAssets!: EntityTable<MediaAsset, "id">;
  mediaBlobs!: EntityTable<MediaBlobRow, "id">;
  lists!: EntityTable<List, "id">;
  listBlocks!: EntityTable<ListBlockRow, "id">;
  posts!: EntityTable<Post, "id">;
  postBlocks!: EntityTable<PostBlockRow, "id">;
  blockNoteAttachments!: EntityTable<BlockNoteAttachment, "id">;
  importBatches!: EntityTable<ImportBatchRow, "id">;
  importItems!: EntityTable<ImportItemRow, "id">;
  importSources!: EntityTable<ImportSourceRow, "sourceKey">;
  publications!: EntityTable<Publication, "id">;
  credentials!: EntityTable<EditorCredential, "id">;
  publicationJobs!: EntityTable<PublicationJobsRow, "publicationId">;
  mutationOutbox!: EntityTable<MutationRow, "id">;
  syncState!: EntityTable<SyncStateRow, "id">;
  syncRevs!: EntityTable<SyncRevRow, "key">;
  syncConflicts!: EntityTable<SyncConflictRow, "id">;

  constructor(name = "placemarks") {
    super(name);
    this.version(1).stores({
      places: "id, resolutionState, updatedAt, *refKeys",
      tags: "id, nameNorm, updatedAt",
      tagAssignments: "id, placeId, tagId, [placeId+tagId], updatedAt",
      notes: "id, targetKey, updatedAt",
      mediaAssets: "id, updatedAt",
      mediaBlobs: "id",
      lists: "id, updatedAt",
      listBlocks: "id, listId, kind, refId, updatedAt",
      posts: "id, listId, updatedAt",
      postBlocks: "id, postId, kind, refId, updatedAt",
      blockNoteAttachments: "id, blockId, noteId, [blockId+noteId], updatedAt",
      importBatches: "id, status, startedAt",
      importItems: "id, batchId, status",
      importSources: "sourceKey",
      publications: "id, status, updatedAt",
      credentials: "id",
      publicationJobs: "publicationId",
      mutationOutbox: "id, table, entityId, createdAt",
      syncState: "id",
      syncRevs: "key",
      syncConflicts: "id, at",
    });
  }
}
