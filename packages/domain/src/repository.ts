/**
 * The local repository port — the only surface the app uses for reads/writes.
 * Implementations (Dexie on web) must enforce the cross-entity invariants from
 * book/src/data-model.md inside transactions:
 *  - a section note targets the same list as its section block;
 *  - an attached place note targets the same PlaceId as the block's saved place;
 *  - live (blockId, noteId) edges and (savedPlaceId, tagId) assignments are unique;
 *  - at most one live SavedPlace per PlaceId;
 *  - deletes tombstone dependents in the same transaction.
 */
import type {
  BlockNoteAttachment,
  List,
  ListBlock,
  MediaAsset,
  Note,
  SavedPlace,
  Tag,
  TagAssignment,
} from "./entities";
import type { OsmElementRef } from "./osm";
import type { ManualFacts, Place, PlaceId } from "./place";
import type { ResolvedPoi } from "./poi";

export interface SavedPlaceView {
  savedPlace: SavedPlace;
  place: Place;
  tags: Tag[];
}

export interface GuideBlockView {
  block: ListBlock;
  /** Present for section blocks. */
  sectionNote?: Note;
  /** Present for place blocks. */
  savedPlace?: SavedPlace;
  place?: Place;
  attachments?: { attachment: BlockNoteAttachment; note: Note }[];
}

export interface PlacemarksRepository {
  // Places
  getPlace(id: PlaceId): Promise<Place | undefined>;
  findPlaceByOsmRef(ref: OsmElementRef): Promise<Place | undefined>;
  updatePlace(place: Place): Promise<void>;
  /** Atomically create-or-reuse a Place for a resolved POI and save it. */
  savePoi(poi: ResolvedPoi, now: string): Promise<SavedPlaceView>;
  /** Create and save an unlinked manual pin. */
  saveManual(facts: ManualFacts, now: string): Promise<SavedPlaceView>;
  listSavedPlaces(): Promise<SavedPlaceView[]>;
  getSavedPlace(id: string): Promise<SavedPlaceView | undefined>;
  findSavedPlaceByPlaceId(placeId: PlaceId): Promise<SavedPlace | undefined>;
  /** Tombstones the save, its tag assignments, place blocks, and private place notes. */
  unsave(savedPlaceId: string, now: string): Promise<void>;

  // Tags
  listTags(): Promise<Tag[]>;
  /** Reuses an existing tag by normalized name; enforces one live assignment per pair. */
  assignTag(savedPlaceId: string, tagName: string, now: string): Promise<TagAssignment>;
  removeTagAssignment(savedPlaceId: string, tagId: string, now: string): Promise<void>;

  // Notes
  listNotesForPlace(placeId: PlaceId): Promise<Note[]>;
  createNote(note: Note): Promise<void>;
  updateNote(note: Note): Promise<void>;
  deleteNote(noteId: string, now: string): Promise<void>;

  // Media
  putMedia(asset: MediaAsset, blob: Blob): Promise<void>;
  getMedia(id: string): Promise<{ asset: MediaAsset; blob: Blob } | undefined>;

  // Lists / guides
  listLists(): Promise<List[]>;
  getList(id: string): Promise<List | undefined>;
  createList(list: List): Promise<void>;
  updateList(list: List): Promise<void>;
  /** Tombstones the list, its blocks, attachments, and list-section notes atomically. */
  deleteList(listId: string, now: string): Promise<void>;
  getGuideBlocks(listId: string): Promise<GuideBlockView[]>;
  /** Lists that currently contain this saved place (for add-to-list filtering). */
  listIdsForSavedPlace(savedPlaceId: string): Promise<string[]>;
  /** A place may appear at most once in a list. */
  addPlaceBlock(listId: string, savedPlaceId: string, now: string): Promise<ListBlock>;
  /** Creates the section Note (target = list) and its block in one transaction. */
  addSectionBlock(listId: string, body: string, now: string, title?: string): Promise<ListBlock>;
  /** Move a block before the given sibling (or to the end when beforeBlockId is null). */
  moveBlock(blockId: string, beforeBlockId: string | null, now: string): Promise<void>;
  removeBlock(blockId: string, now: string): Promise<void>;
  attachNoteToBlock(blockId: string, noteId: string, now: string): Promise<BlockNoteAttachment>;
  detachNoteFromBlock(blockId: string, noteId: string, now: string): Promise<void>;
}
