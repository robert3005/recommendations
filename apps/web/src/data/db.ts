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
  List,
  ListBlock,
  MediaAsset,
  Note,
  Place,
  Tag,
  TagAssignment,
} from "@placemarks/domain";
import Dexie, { type EntityTable } from "dexie";

export type PlaceRow = Place & { refKeys: string[] };
export type NoteRow = Note & { targetKey: string };
export type ListBlockRow = ListBlock & { kind: "section" | "place"; refId: string };
export interface MediaBlobRow {
  id: string;
  blob: Blob;
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
  }
}
