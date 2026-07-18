/**
 * The local repository port — the only surface the app uses for reads/writes.
 * Core rule (book/src/data-model.md, 2026-07-18): **membership is existence** —
 * a place persists only while it belongs to at least one list. There is no
 * standalone "save". Implementations must enforce, inside transactions:
 *  - a place appears at most once per list; removing its last membership
 *    removes the place together with its tags and notes;
 *  - one live TagAssignment per (placeId, tagId); tag reuse by normalized name;
 *  - a section note targets the same list as its section block;
 *  - an attached place note targets the same PlaceId as the block's place;
 *  - deletes tombstone dependents in the same transaction.
 */
import type { BlockNoteAttachment, List, ListBlock, MediaAsset, Note, Tag } from "./entities";
import type { OsmElementRef } from "./osm";
import type { ExternalRef, ManualFacts, Place, PlaceId } from "./place";
import type { ResolvedPoi } from "./poi";

export interface PlaceView {
  place: Place;
  tags: Tag[];
}

export interface GuideBlockView {
  block: ListBlock;
  /** Present for section blocks. */
  sectionNote?: Note;
  /** Present for place blocks. */
  place?: Place;
  attachments?: { attachment: BlockNoteAttachment; note: Note }[];
}

/**
 * What is being added to a list — adding IS how a place comes to exist.
 * An `import` row keeps its identity as an import even when OSM-matched: the
 * optional `poi` links the created/reused place without changing its origin,
 * imported facts, or retained external ref (book/src/interop.md). Import dedup
 * order: external-ref id, then the poi's OSM ref, then name+proximity.
 */
export type AddToListSource =
  | { kind: "poi"; poi: ResolvedPoi; externalRef?: ExternalRef }
  | { kind: "manual"; facts: ManualFacts }
  | { kind: "import"; facts: ManualFacts; externalRef?: ExternalRef; poi?: ResolvedPoi }
  | { kind: "existing"; placeId: PlaceId };

export interface PlacemarksRepository {
  // Places (existence = list membership)
  getPlace(id: PlaceId): Promise<Place | undefined>;
  findPlaceByOsmRef(ref: OsmElementRef): Promise<Place | undefined>;
  updatePlace(place: Place): Promise<void>;
  /** Places currently in at least one list. */
  listPlaces(): Promise<PlaceView[]>;
  getPlaceView(placeId: PlaceId): Promise<PlaceView | undefined>;
  /** Removes the place from every list and tombstones it with its tags and notes. */
  removePlace(placeId: PlaceId, now: string): Promise<void>;

  // Tags
  listTags(): Promise<Tag[]>;
  /** Reuses an existing tag by normalized name; enforces one live assignment per pair. */
  assignTag(placeId: PlaceId, tagName: string, now: string): Promise<void>;
  removeTagAssignment(placeId: PlaceId, tagId: string, now: string): Promise<void>;

  // Notes
  listNotesForPlace(placeId: PlaceId): Promise<Note[]>;
  createNote(note: Note): Promise<void>;
  updateNote(note: Note): Promise<void>;
  deleteNote(noteId: string, now: string): Promise<void>;

  // Media
  putMedia(asset: MediaAsset, blob: Blob): Promise<void>;
  getMedia(id: string): Promise<{ asset: MediaAsset; blob: Blob } | undefined>;

  // Lists
  listLists(): Promise<List[]>;
  getList(id: string): Promise<List | undefined>;
  createList(list: List): Promise<void>;
  updateList(list: List): Promise<void>;
  /**
   * Tombstones the list, its blocks, attachments, and section notes atomically.
   * Places whose only membership was this list are removed (membership is existence).
   */
  deleteList(listId: string, now: string): Promise<void>;
  getGuideBlocks(listId: string): Promise<GuideBlockView[]>;
  /** Lists that currently contain this place (dropdown filtering). */
  listIdsForPlace(placeId: PlaceId): Promise<string[]>;
  /** placeId → listIds across all live lists (pin colouring). */
  listMembershipByPlace(): Promise<Record<string, string[]>>;
  /**
   * The one way a place enters the library: resolve/create it and add it to a
   * list. A place may appear at most once per list.
   */
  addToList(listId: string, source: AddToListSource, now: string): Promise<PlaceView>;
  /** Creates the section Note (target = list) and its block in one transaction. */
  addSectionBlock(listId: string, body: string, now: string, title?: string): Promise<ListBlock>;
  /** Move a block before the given sibling (or to the end when beforeBlockId is null). */
  moveBlock(blockId: string, beforeBlockId: string | null, now: string): Promise<void>;
  /** Removing a place block from its last list removes the place (cascade). */
  removeBlock(blockId: string, now: string): Promise<void>;
  attachNoteToBlock(blockId: string, noteId: string, now: string): Promise<BlockNoteAttachment>;
  detachNoteFromBlock(blockId: string, noteId: string, now: string): Promise<void>;
}
