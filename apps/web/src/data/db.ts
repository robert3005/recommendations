/**
 * Dexie schema — the durable primary store (book/src/storage-sync.md).
 * Rows carry derived index fields (refKeys, targetKey, kind/refId) next to the
 * domain shape; the repository strips/derives them at the boundary.
 *
 * v2/v3 (2026-07-18): the standalone "save" concept was removed — membership is
 * existence. Tag assignments and place blocks join directly on PlaceId; the old
 * savedPlaces rows are migrated through and then dropped.
 */
import type {
  BlockNoteAttachment,
  EditorCredential,
  List,
  ListBlock,
  MediaAsset,
  Note,
  Place,
  Publication,
  Tag,
  TagAssignment,
} from "@placemarks/domain";
import { rankAfter } from "@placemarks/domain";
import Dexie, { type EntityTable } from "dexie";
import { newId } from "../lib/id";

export type PlaceRow = Place & { refKeys: string[] };
export type NoteRow = Note & { targetKey: string };
export type ListBlockRow = ListBlock & { kind: "section" | "place"; refId: string };
export interface MediaBlobRow {
  id: string;
  blob: Blob;
}

/**
 * Import workflow state (book/src/interop.md §Import queue model): persisted so
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

/** One durable publish/revoke job (book/src/sharing.md §Local publication record). */
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
  blockNoteAttachments!: EntityTable<BlockNoteAttachment, "id">;
  importBatches!: EntityTable<ImportBatchRow, "id">;
  importItems!: EntityTable<ImportItemRow, "id">;
  importSources!: EntityTable<ImportSourceRow, "sourceKey">;
  publications!: EntityTable<Publication, "id">;
  credentials!: EntityTable<EditorCredential, "id">;
  publicationOutbox!: EntityTable<PublicationJobRow, "id">;

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
    // list instead (book/src/storage-sync.md §Backup and restore).
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
    // v5 (Phase 3, book/src/interop.md): the persisted import review queue.
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
  }
}
