/**
 * The local repository port — the only surface the app uses for reads/writes.
 * Core rules (spec/src/data-model.md):
 *  - **Membership is existence** (2026-07-18): a place persists only while it
 *    belongs to at least one list; there is no standalone "save".
 *  - **Bottom-up teardown** (2026-07-19, late): deletion never cascades through
 *    authored content — it is refused, with the blockers named, until the owner
 *    has dismantled what hangs off the target. Removing a place from a list is
 *    refused while a live post about that list embeds it; the removal that
 *    would delete the place outright is additionally refused while the place
 *    carries live notes; a list deletes only once it is empty and no live post
 *    editorialises it. Pure edges (tag assignments, tag selections) cascade;
 *    written content never does.
 *  - Lists carry membership only; the editorial layer is the Post aggregate
 *    (ordered section/place blocks, note attachments, tag selections).
 *  - Live list markers are unique (colour, icon) pairs.
 * Implementations must enforce, inside transactions:
 *  - a place appears at most once per list and per post;
 *  - one live TagAssignment per (placeId, tagId); tag reuse by normalized name;
 *  - a section note targets the same post as its section block;
 *  - a live place embed's place is a live member of the post's list;
 *  - an attached place note targets the same PlaceId as the embed's place;
 *  - a selected tag is actually assigned to the embed's place;
 *  - live (blockId, noteId) and (blockId, tagId) edges are unique.
 */
import type {
  BlockNoteAttachment,
  List,
  ListBlock,
  MediaAsset,
  Note,
  Post,
  PostBlock,
  Tag,
} from "./entities";
import type { OsmElementRef } from "./osm";
import type { ExternalRef, ManualFacts, Place, PlaceId } from "./place";
import type { ResolvedPoi } from "./poi";

export interface PlaceView {
  place: Place;
  tags: Tag[];
}

/** A list's membership entry — list blocks carry places only (2026-07-19). */
export interface ListBlockView {
  block: ListBlock;
  place: Place;
}

/** One rendered block of a post: a narrative section or a place embed. */
export interface PostBlockView {
  block: PostBlock;
  /** Present for section blocks. */
  sectionNote?: Note;
  /** Present for place blocks. */
  place?: Place;
  /** Shareable place notes attached to a place embed, in rank order. */
  attachments?: { attachment: BlockNoteAttachment; note: Note }[];
  /** Tags explicitly selected for publication on a place embed. */
}

/**
 * Why a teardown was refused (spec/src/posts.md §Where embeds come from):
 * every refusal is actionable — the dialog names the blockers and links to
 * them, and the owner dismantles them explicitly.
 */
export interface TeardownBlockers {
  /** Live notes on a place whose existence would end with this removal. */
  notes: { placeId: PlaceId; noteId: string; title?: string }[];
  /** Live post embeds that reference a place in the removal's scope. */
  embeds: { placeId: PlaceId; postId: string; postTitle: string; blockId: string }[];
  /** Live posts editorialising a list that was asked to delete. */
  posts: { postId: string; title: string }[];
  /** Places still members of a list that was asked to delete. */
  members: PlaceId[];
}

export function emptyBlockers(): TeardownBlockers {
  return { notes: [], embeds: [], posts: [], members: [] };
}

export function hasBlockers(blockers: TeardownBlockers): boolean {
  return (
    blockers.notes.length > 0 ||
    blockers.embeds.length > 0 ||
    blockers.posts.length > 0 ||
    blockers.members.length > 0
  );
}

/** Thrown when bottom-up teardown refuses a removal; carries the report. */
export class TeardownRefusedError extends Error {
  readonly blockers: TeardownBlockers;

  constructor(message: string, blockers: TeardownBlockers) {
    super(message);
    this.name = "TeardownRefusedError";
    this.blockers = blockers;
  }
}

/**
 * What is being added to a list — adding IS how a place comes to exist.
 * An `import` row keeps its identity as an import even when OSM-matched: the
 * optional `poi` links the created/reused place without changing its origin,
 * imported facts, or retained external ref (spec/src/interop.md). Import dedup
 * order: external-ref id, then the poi's OSM ref, then name+proximity.
 */
export type AddToListSource =
  | { kind: "poi"; poi: ResolvedPoi; externalRef?: ExternalRef }
  | { kind: "manual"; facts: ManualFacts }
  | {
      kind: "import";
      facts: ManualFacts;
      externalRef?: ExternalRef;
      poi?: ResolvedPoi;
      /** True when the poi came from an exact source anchor — fuzzy name dedup never overrides it. */
      authoritative?: boolean;
    }
  | { kind: "existing"; placeId: PlaceId };

export interface PlacemarksRepository {
  // Places (existence = list membership)
  getPlace(id: PlaceId): Promise<Place | undefined>;
  findPlaceByOsmRef(ref: OsmElementRef): Promise<Place | undefined>;
  updatePlace(place: Place): Promise<void>;
  /** Places currently in at least one list. */
  listPlaces(): Promise<PlaceView[]>;
  getPlaceView(placeId: PlaceId): Promise<PlaceView | undefined>;
  /**
   * Removes the place from every list, ending its existence. Refused
   * (TeardownRefusedError) while the place carries live notes or any live
   * post embeds it; once clear, tombstones the place with its tag assignments
   * and membership blocks in one transaction.
   */
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
  /** Enforces live-marker uniqueness — a duplicate (colour, icon) pair is refused. */
  createList(list: List): Promise<void>;
  /** Enforces live-marker uniqueness — a duplicate (colour, icon) pair is refused. */
  updateList(list: List): Promise<void>;
  /**
   * Deletes the list. Refused (TeardownRefusedError) until the list is empty
   * and no live post editorialises it (spec/src/data-model.md §Relationships);
   * nothing cascades through it.
   */
  deleteList(listId: string, now: string): Promise<void>;
  /** The list's membership in rank order. */
  getListBlocks(listId: string): Promise<ListBlockView[]>;
  /** Lists that currently contain this place (dropdown filtering). */
  listIdsForPlace(placeId: PlaceId): Promise<string[]>;
  /** placeId → listIds across all live lists (pin markers). */
  listMembershipByPlace(): Promise<Record<string, string[]>>;
  /**
   * The one way a place enters the library: resolve/create it and add it to a
   * list. A place may appear at most once per list.
   */
  addToList(listId: string, source: AddToListSource, now: string): Promise<PlaceView>;
  /** Move a membership block before the given sibling (or to the end when beforeBlockId is null). */
  moveBlock(blockId: string, beforeBlockId: string | null, now: string): Promise<void>;
  /**
   * Removes a membership block. Refused (TeardownRefusedError) while a live
   * post about the list embeds the place, or — when this is the place's last
   * membership — while the place carries live notes. An allowed last-membership
   * removal deletes the place with its tag assignments in the same transaction.
   */
  removeBlock(blockId: string, now: string): Promise<void>;
  /**
   * Edit mode's bulk removal: empties the list in one transaction, or refuses
   * with an actionable blocker report naming every blocked place
   * (spec/src/posts.md — places with notes, places embedded in posts).
   */
  removeAllPlaces(listId: string, now: string): Promise<void>;

  // Posts (the editorial layer — spec/src/posts.md)
  listPosts(): Promise<Post[]>;
  listPostsForList(listId: string): Promise<Post[]>;
  getPost(id: string): Promise<Post | undefined>;
  /** The post's list must be live. */
  createPost(post: Post): Promise<void>;
  updatePost(post: Post): Promise<void>;
  /**
   * Deleting a post is itself the explicit act: its blocks, its own section
   * notes, attachments, and selections go with it; the list, its places, and
   * place notes are untouched. Hosted publications of the post queue
   * revocation.
   */
  deletePost(postId: string, now: string): Promise<void>;
  getPostBlocks(postId: string): Promise<PostBlockView[]>;
  /** Creates the section Note (target = post) and its block in one transaction. */
  addPostSection(postId: string, body: string, now: string, title?: string): Promise<PostBlock>;
  /**
   * Embeds a live member of the post's list (spec/src/posts.md §Where embeds
   * come from — embedding a non-member goes through addToList first). A place
   * may be embedded at most once per post.
   */
  embedPlaceInPost(postId: string, placeId: PlaceId, now: string): Promise<PostBlock>;
  /** Move a post block before the given sibling (or to the end when beforeBlockId is null). */
  movePostBlock(blockId: string, beforeBlockId: string | null, now: string): Promise<void>;
  /** Removes a post block; a section block takes its post-owned note with it. */
  removePostBlock(blockId: string, now: string): Promise<void>;
  attachNoteToPostBlock(blockId: string, noteId: string, now: string): Promise<BlockNoteAttachment>;
  detachNoteFromPostBlock(blockId: string, noteId: string, now: string): Promise<void>;
}
