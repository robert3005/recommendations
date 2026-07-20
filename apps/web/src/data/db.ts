/**
 * Dexie schema — the durable primary store (spec/src/storage-sync.md).
 * Rows carry derived index fields (refKeys, targetKey, kind/refId) next to the
 * domain shape; the repository strips/derives them at the boundary.
 *
 * v2/v3 (2026-07-18): the standalone "save" concept was removed — membership is
 * existence. Tag assignments and place blocks join directly on PlaceId; the old
 * savedPlaces rows are migrated through and then dropped.
 */
import type {
  BlockNoteAttachment,
  BlockTagSelection,
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
} from "@placemarks/domain";
import { rankAfter } from "@placemarks/domain";
import Dexie, { type EntityTable } from "dexie";
import { newId } from "../lib/id";
import {
  type PivotAttachmentRow,
  type PivotBlockRow,
  type PivotListRow,
  type PivotNoteRow,
  type PivotPublicationRow,
  pivotGuideLayer,
} from "./pivot";

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
  row: Record<string, unknown>;
  createdAt: string;
}

/** Device-scoped sync state: account, cursor, clock — never part of backups. */
export interface SyncStateRow {
  id: "sync";
  actorId: string;
  accountId?: string;
  /** Bearer token naming the sync scope; never in any public document. */
  token?: string;
  email?: string;
  cursor?: string;
  lastSyncedAt?: string;
  lastError?: string;
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
  origin: "local" | "remote";
}

/**
 * Rescued content a sync interleaving orphaned (e.g. a note edit racing its
 * target's teardown) — recoverable, never silently dropped.
 */
export interface SyncConflictRow {
  id: string;
  kind: "orphaned-note";
  title?: string;
  body: string;
  reason: string;
  at: string;
}

/** One durable publish/revoke job (spec/src/sharing.md §Local publication record). */
export interface PublicationJobRow {
  id: string; // doubles as the Idempotency-Key
  publicationId: string;
  action: "publish" | "revoke";
  /** The local revision this job projects — completing an older job never rolls forward state back. */
  localRevision: string;
  /** The exact serialized document this job publishes (captured at enqueue). */
  payload?: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
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
  blockTagSelections!: EntityTable<BlockTagSelection, "id">;
  importBatches!: EntityTable<ImportBatchRow, "id">;
  importItems!: EntityTable<ImportItemRow, "id">;
  importSources!: EntityTable<ImportSourceRow, "sourceKey">;
  publications!: EntityTable<Publication, "id">;
  credentials!: EntityTable<EditorCredential, "id">;
  publicationOutbox!: EntityTable<PublicationJobRow, "id">;
  mutationOutbox!: EntityTable<MutationRow, "id">;
  syncState!: EntityTable<SyncStateRow, "id">;
  syncRevs!: EntityTable<SyncRevRow, "key">;
  syncConflicts!: EntityTable<SyncConflictRow, "id">;

  constructor(name = "placemarks") {
    super(name);
    this.version(1).stores({
      places: "id, resolutionState, updatedAt, *refKeys",
      savedPlaces: "id, placeId, updatedAt",
      tags: "id, nameNorm, updatedAt",
      tagAssignments: "id, savedPlaceId, tagId, [savedPlaceId+tagId], updatedAt",
      notes: "id, targetKey, updatedAt",
      mediaAssets: "id, updatedAt",
      mediaBlobs: "id",
      lists: "id, updatedAt",
      listBlocks: "id, listId, kind, refId, updatedAt",
      blockNoteAttachments: "id, blockId, noteId, [blockId+noteId], updatedAt",
    });
    // v2: edges join on PlaceId directly; migrate via the old savedPlaces rows.
    this.version(2)
      .stores({
        tagAssignments: "id, placeId, tagId, [placeId+tagId], updatedAt",
      })
      .upgrade(async (tx) => {
        const saves = (await tx.table("savedPlaces").toArray()) as {
          id: string;
          placeId: string;
        }[];
        const placeIdBySaveId = new Map(saves.map((s) => [s.id, s.placeId]));
        await tx
          .table("tagAssignments")
          .toCollection()
          .modify((a: Record<string, unknown>) => {
            a.placeId = placeIdBySaveId.get(a.savedPlaceId as string) ?? a.savedPlaceId;
            delete a.savedPlaceId;
          });
        await tx
          .table("listBlocks")
          .toCollection()
          .modify((b: Record<string, unknown>) => {
            if (b.kind === "place") {
              const placeId = placeIdBySaveId.get(b.refId as string) ?? (b.refId as string);
              b.refId = placeId;
              b.content = { type: "place", placeId };
            }
          });
      });
    // v3: the savedPlaces store is gone.
    this.version(3).stores({ savedPlaces: null });
    // v4: membership is existence — a live place with no live list membership would
    // be a hidden orphan (invisible but occupying its OSM ref). Formerly saved
    // places that belonged to no list are placed in an explicit migration-created
    // list instead (spec/src/storage-sync.md §Backup and restore).
    this.version(4).upgrade(async (tx) => {
      const places = (await tx.table("places").toArray()) as {
        id: string;
        deleted?: boolean;
      }[];
      const blocks = (await tx.table("listBlocks").toArray()) as {
        kind: string;
        refId: string;
        deleted?: boolean;
      }[];
      const withMembership = new Set(
        blocks.filter((b) => !b.deleted && b.kind === "place").map((b) => b.refId),
      );
      const orphans = places.filter((p) => !p.deleted && !withMembership.has(p.id));
      if (orphans.length === 0) return;
      const now = new Date().toISOString();
      const listId = newId();
      await tx
        .table("lists")
        .put({ id: listId, name: "Saved places", createdAt: now, updatedAt: now });
      let rank: string | null = null;
      for (const orphan of orphans) {
        rank = rankAfter(rank);
        await tx.table("listBlocks").put({
          id: newId(),
          listId,
          rank,
          kind: "place",
          refId: orphan.id,
          content: { type: "place", placeId: orphan.id },
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    // v5 (Phase 3, spec/src/interop.md): the persisted import review queue.
    this.version(5).stores({
      importBatches: "id, status, startedAt",
      importItems: "id, batchId, status",
    });
    // v6 (Phases 3/5): source-list identity across re-imports (a renamed local
    // list stays canonical), and the publication machinery — publications,
    // device-held editor credentials, and the durable publication outbox.
    this.version(6).stores({
      importSources: "sourceKey",
      publications: "id, status, updatedAt",
      credentials: "id",
      publicationOutbox: "id, publicationId, createdAt",
    });
    // v7 (2026-07-19 lists-and-posts pivot, spec/src/posts.md §Migration from
    // the guide layer):
    //  - every list gets a unique (colour, icon) marker; legacy colour-only
    //    lists keep their colour and gain an icon;
    //  - a list carrying editorial content (section blocks, note attachments,
    //    or list-targeted notes) gets a same-titled post created from it; the
    //    list keeps only its place blocks;
    //  - list-targeted notes retarget to the created post; attachments move to
    //    the post's blocks; a publication of such a list follows the editorial
    //    content to the post but keeps serving from /s/lists under its slug.
    this.version(7)
      .stores({
        posts: "id, listId, updatedAt",
        postBlocks: "id, postId, kind, refId, updatedAt",
        blockTagSelections: "id, blockId, tagId, [blockId+tagId], updatedAt",
      })
      .upgrade(async (tx) => {
        const now = new Date().toISOString();
        const changes = pivotGuideLayer({
          lists: (await tx.table("lists").toArray()) as PivotListRow[],
          listBlocks: (await tx.table("listBlocks").toArray()) as PivotBlockRow[],
          notes: (await tx.table("notes").toArray()) as PivotNoteRow[],
          blockNoteAttachments: (await tx
            .table("blockNoteAttachments")
            .toArray()) as PivotAttachmentRow[],
          publications: (await tx.table("publications").toArray()) as PivotPublicationRow[],
        });
        for (const [listId, marker] of changes.markers) {
          await tx.table("lists").update(listId, {
            marker,
            color: undefined,
            icon: undefined,
          });
        }
        for (const post of changes.posts) {
          await tx.table("posts").put({ ...post, createdAt: now, updatedAt: now });
        }
        for (const block of changes.postBlocks) {
          await tx.table("postBlocks").put({
            ...block,
            content:
              block.kind === "section"
                ? { type: "section", noteId: block.refId }
                : { type: "place", placeId: block.refId },
            createdAt: now,
            updatedAt: now,
          });
        }
        for (const blockId of changes.tombstoneListBlockIds) {
          await tx.table("listBlocks").update(blockId, { deleted: true, updatedAt: now });
        }
        for (const [noteId, postId] of changes.retargetNotes) {
          await tx.table("notes").update(noteId, {
            target: { kind: "post", postId },
            targetKey: `post:${postId}`,
            updatedAt: now,
          });
        }
        for (const [attachmentId, blockId] of changes.moveAttachments) {
          await tx.table("blockNoteAttachments").update(attachmentId, {
            blockId,
            updatedAt: now,
          });
        }
        // The publication follows the editorial content to the post; its
        // hosted slug keeps serving the same document from /s/lists.
        for (const [publicationId, postId] of changes.retargetPublications) {
          await tx.table("publications").update(publicationId, {
            target: { kind: "post", id: postId },
            channel: "lists",
            updatedAt: now,
          });
        }
      });
    // v8 (Phase 8, spec/src/storage-sync.md §Multi-device sync): the durable
    // mutation outbox the sync transport drains, device sync state, applied
    // revision stamps, and rescued sync conflicts.
    this.version(8).stores({
      mutationOutbox: "id, table, entityId, createdAt",
      syncState: "id",
      syncRevs: "key",
      syncConflicts: "id, at",
    });
  }
}
