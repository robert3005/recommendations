/**
 * DexieRepository — the LocalRepository implementation. All cross-entity invariants
 * from book/src/data-model.md are enforced here, inside transactions:
 *  - at most one live SavedPlace per PlaceId;
 *  - one live TagAssignment per (savedPlaceId, tagId); tag reuse by normalized name;
 *  - a place appears at most once per list; section notes belong to their list;
 *  - attachments join a place block to a note about the SAME PlaceId;
 *  - deletes tombstone dependents in the same transaction.
 */
import {
  allRefKeys,
  type BlockNoteAttachment,
  compareByRank,
  createManualPlace,
  createOsmPlace,
  evidenceFromPoi,
  type GuideBlockView,
  type List,
  type ListBlock,
  type ManualFacts,
  type MediaAsset,
  type Note,
  noteTargetKey,
  type OsmElementRef,
  type Place,
  type PlacemarksRepository,
  type PlaceId,
  rankAfter,
  rankBetween,
  refKey,
  type ResolvedPoi,
  type SavedPlace,
  type SavedPlaceView,
  sameRef,
  type Tag,
  type TagAssignment,
  normalizeTagName,
} from "@placemarks/domain";
import { newId } from "../lib/id";
import { type ListBlockRow, type NoteRow, PlacemarksDb, type PlaceRow } from "./db";

function toPlaceRow(place: Place): PlaceRow {
  return { ...place, refKeys: allRefKeys(place) };
}

function toNoteRow(note: Note): NoteRow {
  return { ...note, targetKey: noteTargetKey(note.target) };
}

function toBlockRow(block: ListBlock): ListBlockRow {
  return {
    ...block,
    kind: block.content.type,
    refId: block.content.type === "section" ? block.content.noteId : block.content.savedPlaceId,
  };
}

const live = <T extends { deleted?: boolean }>(row: T | undefined): T | undefined =>
  row && !row.deleted ? row : undefined;

export class DexieRepository implements PlacemarksRepository {
  readonly db: PlacemarksDb;

  constructor(dbName?: string) {
    this.db = new PlacemarksDb(dbName);
  }

  // ---------- places ----------

  async getPlace(id: PlaceId): Promise<Place | undefined> {
    return live(await this.db.places.get(id));
  }

  async findPlaceByOsmRef(ref: OsmElementRef): Promise<Place | undefined> {
    // Never .first() + live(): a tombstoned row can shadow the live one.
    const rows = await this.db.places.where("refKeys").equals(refKey(ref)).toArray();
    return rows.find((row) => !row.deleted);
  }

  private async liveSaveForPlace(placeId: PlaceId): Promise<SavedPlace | undefined> {
    const rows = await this.db.savedPlaces.where("placeId").equals(placeId).toArray();
    return rows.find((row) => !row.deleted);
  }

  async updatePlace(place: Place): Promise<void> {
    await this.db.places.put(toPlaceRow(place));
  }

  private async viewOf(savedPlace: SavedPlace): Promise<SavedPlaceView> {
    const place = await this.db.places.get(savedPlace.placeId);
    if (!place) throw new Error(`missing place ${savedPlace.placeId}`);
    const assignments = (
      await this.db.tagAssignments.where("savedPlaceId").equals(savedPlace.id).toArray()
    ).filter((a) => !a.deleted);
    const tags = (
      await Promise.all(assignments.map((a) => this.db.tags.get(a.tagId)))
    ).filter((t): t is Tag => t !== undefined && !t.deleted);
    return { savedPlace, place, tags };
  }

  async savePoi(poi: ResolvedPoi, now: string): Promise<SavedPlaceView> {
    return this.db.transaction("rw", [this.db.places, this.db.savedPlaces, this.db.tagAssignments, this.db.tags], async () => {
      const found = (
        await this.db.places.where("refKeys").equals(refKey(poi.osmRef)).toArray()
      ).find((row) => !row.deleted);
      let place: Place;
      if (found) {
        // Current-ref match refreshes evidence; a historical-ref match means this
        // element was already replaced — reuse the place, keep the newer binding.
        if (found.currentOsmRef && sameRef(found.currentOsmRef, poi.osmRef)) {
          place = {
            ...found,
            lastVerified: evidenceFromPoi(poi),
            resolutionState: "resolved",
            lastResolutionAttemptAt: now,
            updatedAt: now,
          };
          await this.db.places.put(toPlaceRow(place));
        } else {
          place = found;
        }
      } else {
        place = createOsmPlace(newId(), poi, now);
        await this.db.places.put(toPlaceRow(place));
      }
      const existingSave = await this.liveSaveForPlace(place.id);
      if (existingSave) return this.viewOf(existingSave);
      const savedPlace: SavedPlace = {
        id: newId(),
        placeId: place.id,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.savedPlaces.put(savedPlace);
      return this.viewOf(savedPlace);
    });
  }

  async saveManual(facts: ManualFacts, now: string): Promise<SavedPlaceView> {
    return this.db.transaction("rw", [this.db.places, this.db.savedPlaces], async () => {
      const place = createManualPlace(newId(), facts, now);
      await this.db.places.put(toPlaceRow(place));
      const savedPlace: SavedPlace = {
        id: newId(),
        placeId: place.id,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.savedPlaces.put(savedPlace);
      return { savedPlace, place, tags: [] };
    });
  }

  async listSavedPlaces(): Promise<SavedPlaceView[]> {
    const saves = (await this.db.savedPlaces.toArray()).filter((s) => !s.deleted);
    return Promise.all(saves.map((s) => this.viewOf(s)));
  }

  async getSavedPlace(id: string): Promise<SavedPlaceView | undefined> {
    const savedPlace = live(await this.db.savedPlaces.get(id));
    if (!savedPlace) return undefined;
    return this.viewOf(savedPlace);
  }

  async findSavedPlaceByPlaceId(placeId: PlaceId): Promise<SavedPlace | undefined> {
    return this.liveSaveForPlace(placeId);
  }

  async unsave(savedPlaceId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.savedPlaces,
        this.db.tagAssignments,
        this.db.listBlocks,
        this.db.blockNoteAttachments,
        this.db.notes,
      ],
      async () => {
        const savedPlace = live(await this.db.savedPlaces.get(savedPlaceId));
        if (!savedPlace) return;
        await this.db.savedPlaces.put({ ...savedPlace, deleted: true, updatedAt: now });
        // Tombstone tag assignments.
        const assignments = await this.db.tagAssignments
          .where("savedPlaceId")
          .equals(savedPlaceId)
          .toArray();
        for (const a of assignments.filter((a) => !a.deleted)) {
          await this.db.tagAssignments.put({ ...a, deleted: true, updatedAt: now });
        }
        // Tombstone place blocks in every guide (and their attachments).
        const blocks = (
          await this.db.listBlocks.where("refId").equals(savedPlaceId).toArray()
        ).filter((b) => !b.deleted && b.kind === "place");
        for (const block of blocks) {
          await this.tombstoneBlock(block, now);
        }
        // Tombstone private place notes.
        const notes = (
          await this.db.notes.where("targetKey").equals(`place:${savedPlace.placeId}`).toArray()
        ).filter((n) => !n.deleted);
        for (const note of notes) {
          await this.tombstoneNote(note, now);
        }
      },
    );
  }

  // ---------- tags ----------

  async listTags(): Promise<Tag[]> {
    return (await this.db.tags.toArray()).filter((t) => !t.deleted);
  }

  async assignTag(savedPlaceId: string, tagName: string, now: string): Promise<TagAssignment> {
    return this.db.transaction("rw", [this.db.tags, this.db.tagAssignments, this.db.savedPlaces], async () => {
      const savedPlace = live(await this.db.savedPlaces.get(savedPlaceId));
      if (!savedPlace) throw new Error("cannot tag: saved place not found");
      const nameNorm = normalizeTagName(tagName);
      if (nameNorm === "") throw new Error("cannot tag: empty tag name");
      let tag = (await this.db.tags.where("nameNorm").equals(nameNorm).toArray()).find(
        (t) => !t.deleted,
      );
      if (!tag) {
        tag = {
          id: newId(),
          name: tagName.trim(),
          nameNorm,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.tags.put(tag);
      }
      const pair = await this.db.tagAssignments
        .where("[savedPlaceId+tagId]")
        .equals([savedPlaceId, tag.id])
        .toArray();
      const existing = pair.find((a) => !a.deleted);
      if (existing) return existing;
      const assignment: TagAssignment = {
        id: newId(),
        savedPlaceId,
        tagId: tag.id,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.tagAssignments.put(assignment);
      return assignment;
    });
  }

  async removeTagAssignment(savedPlaceId: string, tagId: string, now: string): Promise<void> {
    const pair = await this.db.tagAssignments
      .where("[savedPlaceId+tagId]")
      .equals([savedPlaceId, tagId])
      .toArray();
    const existing = pair.find((a) => !a.deleted);
    if (existing) {
      await this.db.tagAssignments.put({ ...existing, deleted: true, updatedAt: now });
    }
  }

  // ---------- notes ----------

  async listNotesForPlace(placeId: PlaceId): Promise<Note[]> {
    return (await this.db.notes.where("targetKey").equals(`place:${placeId}`).toArray()).filter(
      (n) => !n.deleted,
    );
  }

  async createNote(note: Note): Promise<void> {
    await this.db.notes.put(toNoteRow(note));
  }

  async updateNote(note: Note): Promise<void> {
    await this.db.notes.put(toNoteRow(note));
  }

  private async tombstoneNote(note: Note, now: string): Promise<void> {
    await this.db.notes.put(toNoteRow({ ...note, deleted: true, updatedAt: now }));
    // A deleted note disappears from every guide attachment…
    const attachments = (
      await this.db.blockNoteAttachments.where("noteId").equals(note.id).toArray()
    ).filter((a) => !a.deleted);
    for (const a of attachments) {
      await this.db.blockNoteAttachments.put({ ...a, deleted: true, updatedAt: now });
    }
    // …and a deleted section note removes its section block.
    if (note.target.kind === "list") {
      const blocks = (await this.db.listBlocks.where("refId").equals(note.id).toArray()).filter(
        (b) => !b.deleted && b.kind === "section",
      );
      for (const b of blocks) {
        await this.db.listBlocks.put({ ...b, deleted: true, updatedAt: now });
      }
    }
  }

  async deleteNote(noteId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.notes, this.db.blockNoteAttachments, this.db.listBlocks],
      async () => {
        const note = live(await this.db.notes.get(noteId));
        if (note) await this.tombstoneNote(note, now);
      },
    );
  }

  // ---------- media ----------

  async putMedia(asset: MediaAsset, blob: Blob): Promise<void> {
    await this.db.transaction("rw", [this.db.mediaAssets, this.db.mediaBlobs], async () => {
      await this.db.mediaAssets.put(asset);
      await this.db.mediaBlobs.put({ id: asset.localBlobKey, blob });
    });
  }

  async getMedia(id: string): Promise<{ asset: MediaAsset; blob: Blob } | undefined> {
    const asset = live(await this.db.mediaAssets.get(id));
    if (!asset) return undefined;
    const blobRow = await this.db.mediaBlobs.get(asset.localBlobKey);
    if (!blobRow) return undefined;
    return { asset, blob: blobRow.blob };
  }

  // ---------- lists / guides ----------

  async listLists(): Promise<List[]> {
    return (await this.db.lists.toArray()).filter((l) => !l.deleted);
  }

  async getList(id: string): Promise<List | undefined> {
    return live(await this.db.lists.get(id));
  }

  async createList(list: List): Promise<void> {
    await this.db.lists.put(list);
  }

  async updateList(list: List): Promise<void> {
    await this.db.lists.put(list);
  }

  private async tombstoneBlock(block: ListBlockRow, now: string): Promise<void> {
    await this.db.listBlocks.put({ ...block, deleted: true, updatedAt: now });
    const attachments = (
      await this.db.blockNoteAttachments.where("blockId").equals(block.id).toArray()
    ).filter((a) => !a.deleted);
    for (const a of attachments) {
      await this.db.blockNoteAttachments.put({ ...a, deleted: true, updatedAt: now });
    }
  }

  async deleteList(listId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.lists, this.db.listBlocks, this.db.blockNoteAttachments, this.db.notes],
      async () => {
        const list = live(await this.db.lists.get(listId));
        if (!list) return;
        await this.db.lists.put({ ...list, deleted: true, updatedAt: now });
        const blocks = (await this.db.listBlocks.where("listId").equals(listId).toArray()).filter(
          (b) => !b.deleted,
        );
        for (const block of blocks) {
          await this.tombstoneBlock(block, now);
        }
        // Section notes belong to the guide and die with it; place notes do not.
        const sectionNotes = (
          await this.db.notes.where("targetKey").equals(`list:${listId}`).toArray()
        ).filter((n) => !n.deleted);
        for (const note of sectionNotes) {
          await this.db.notes.put(toNoteRow({ ...note, deleted: true, updatedAt: now }));
        }
      },
    );
  }

  private async liveBlocks(listId: string): Promise<ListBlockRow[]> {
    const rows = (await this.db.listBlocks.where("listId").equals(listId).toArray()).filter(
      (b) => !b.deleted,
    );
    return rows.sort(compareByRank);
  }

  async getGuideBlocks(listId: string): Promise<GuideBlockView[]> {
    const blocks = await this.liveBlocks(listId);
    return Promise.all(
      blocks.map(async (block) => {
        if (block.content.type === "section") {
          const sectionNote = live(await this.db.notes.get(block.content.noteId));
          return { block, ...(sectionNote ? { sectionNote } : {}) };
        }
        const savedPlace = live(await this.db.savedPlaces.get(block.content.savedPlaceId));
        const place = savedPlace ? live(await this.db.places.get(savedPlace.placeId)) : undefined;
        const attachmentRows = (
          await this.db.blockNoteAttachments.where("blockId").equals(block.id).toArray()
        )
          .filter((a) => !a.deleted)
          .sort(compareByRank);
        const attachments = (
          await Promise.all(
            attachmentRows.map(
              async (
                attachment,
              ): Promise<{ attachment: BlockNoteAttachment; note: Note } | undefined> => {
                const note = live(await this.db.notes.get(attachment.noteId));
                return note ? { attachment, note } : undefined;
              },
            ),
          )
        ).filter((x): x is { attachment: BlockNoteAttachment; note: Note } => x !== undefined);
        return {
          block,
          ...(savedPlace ? { savedPlace } : {}),
          ...(place ? { place } : {}),
          attachments,
        };
      }),
    );
  }

  async addPlaceBlock(listId: string, savedPlaceId: string, now: string): Promise<ListBlock> {
    return this.db.transaction(
      "rw",
      [this.db.lists, this.db.listBlocks, this.db.savedPlaces],
      async () => {
        if (!live(await this.db.lists.get(listId))) throw new Error("list not found");
        if (!live(await this.db.savedPlaces.get(savedPlaceId)))
          throw new Error("saved place not found");
        const blocks = await this.liveBlocks(listId);
        // A place may appear at most once in a list (book/src/data-model.md).
        if (blocks.some((b) => b.kind === "place" && b.refId === savedPlaceId)) {
          throw new Error("place already in this guide");
        }
        const lastRank = blocks.length > 0 ? (blocks[blocks.length - 1]?.rank ?? null) : null;
        const block: ListBlock = {
          id: newId(),
          listId,
          rank: rankAfter(lastRank),
          content: { type: "place", savedPlaceId },
          createdAt: now,
          updatedAt: now,
        };
        await this.db.listBlocks.put(toBlockRow(block));
        return block;
      },
    );
  }

  async addSectionBlock(
    listId: string,
    body: string,
    now: string,
    title?: string,
  ): Promise<ListBlock> {
    return this.db.transaction("rw", [this.db.lists, this.db.listBlocks, this.db.notes], async () => {
      if (!live(await this.db.lists.get(listId))) throw new Error("list not found");
      const note: Note = {
        id: newId(),
        target: { kind: "list", listId },
        ...(title ? { title } : {}),
        body,
        mediaIds: [],
        shareable: false,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.notes.put(toNoteRow(note));
      const blocks = await this.liveBlocks(listId);
      const lastRank = blocks.length > 0 ? (blocks[blocks.length - 1]?.rank ?? null) : null;
      const block: ListBlock = {
        id: newId(),
        listId,
        rank: rankAfter(lastRank),
        content: { type: "section", noteId: note.id },
        createdAt: now,
        updatedAt: now,
      };
      await this.db.listBlocks.put(toBlockRow(block));
      return block;
    });
  }

  async moveBlock(blockId: string, beforeBlockId: string | null, now: string): Promise<void> {
    await this.db.transaction("rw", [this.db.listBlocks], async () => {
      const block = live(await this.db.listBlocks.get(blockId));
      if (!block) throw new Error("block not found");
      const siblings = (await this.liveBlocks(block.listId)).filter((b) => b.id !== blockId);
      let rank: string;
      if (beforeBlockId === null) {
        rank = rankAfter(siblings.length > 0 ? (siblings[siblings.length - 1]?.rank ?? null) : null);
      } else {
        const index = siblings.findIndex((b) => b.id === beforeBlockId);
        if (index === -1) throw new Error("target block not found");
        const before = index > 0 ? (siblings[index - 1]?.rank ?? null) : null;
        rank = rankBetween(before, siblings[index]?.rank ?? null);
      }
      await this.db.listBlocks.put({ ...block, rank, updatedAt: now });
    });
  }

  async removeBlock(blockId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.listBlocks, this.db.blockNoteAttachments, this.db.notes],
      async () => {
        const block = live(await this.db.listBlocks.get(blockId));
        if (!block) return;
        await this.tombstoneBlock(block, now);
        // A removed section block takes its guide-owned note with it.
        if (block.content.type === "section") {
          const note = live(await this.db.notes.get(block.content.noteId));
          if (note) await this.db.notes.put(toNoteRow({ ...note, deleted: true, updatedAt: now }));
        }
      },
    );
  }

  async attachNoteToBlock(
    blockId: string,
    noteId: string,
    now: string,
  ): Promise<BlockNoteAttachment> {
    return this.db.transaction(
      "rw",
      [this.db.listBlocks, this.db.notes, this.db.savedPlaces, this.db.blockNoteAttachments],
      async () => {
        const block = live(await this.db.listBlocks.get(blockId));
        if (!block || block.content.type !== "place") {
          throw new Error("attachments require a place block");
        }
        const note = live(await this.db.notes.get(noteId));
        if (!note) throw new Error("note not found");
        const savedPlace = live(await this.db.savedPlaces.get(block.content.savedPlaceId));
        if (!savedPlace) throw new Error("saved place not found");
        // The invariant: an attached note is about the SAME place as the block.
        if (note.target.kind !== "place" || note.target.placeId !== savedPlace.placeId) {
          throw new Error("note targets a different place than this block");
        }
        const pair = await this.db.blockNoteAttachments
          .where("[blockId+noteId]")
          .equals([blockId, noteId])
          .toArray();
        const existing = pair.find((a) => !a.deleted);
        if (existing) return existing;
        const attachments = (
          await this.db.blockNoteAttachments.where("blockId").equals(blockId).toArray()
        )
          .filter((a) => !a.deleted)
          .sort(compareByRank);
        const lastRank =
          attachments.length > 0 ? (attachments[attachments.length - 1]?.rank ?? null) : null;
        const attachment: BlockNoteAttachment = {
          id: newId(),
          blockId,
          noteId,
          rank: rankAfter(lastRank),
          createdAt: now,
          updatedAt: now,
        };
        await this.db.blockNoteAttachments.put(attachment);
        return attachment;
      },
    );
  }

  async detachNoteFromBlock(blockId: string, noteId: string, now: string): Promise<void> {
    const pair = await this.db.blockNoteAttachments
      .where("[blockId+noteId]")
      .equals([blockId, noteId])
      .toArray();
    const existing = pair.find((a) => !a.deleted);
    if (existing) {
      await this.db.blockNoteAttachments.put({ ...existing, deleted: true, updatedAt: now });
    }
  }
}
