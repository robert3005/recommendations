/**
 * The 2026-07-19 lists-and-posts pivot as a pure transformation
 * (spec/src/posts.md §Migration from the guide layer), shared by the Dexie v7
 * upgrade and by restores of pre-pivot (v2) backup archives:
 *  - every list gets a unique (colour, icon) marker — legacy colour-only lists
 *    keep their colour and gain an icon;
 *  - a list carrying editorial content (section blocks, note attachments, or
 *    list-targeted notes) gets a same-titled post created from that content,
 *    with the post replicating the guide's whole block sequence; the list
 *    keeps only its place blocks;
 *  - list-targeted notes retarget to the created post; attachments move to the
 *    post's blocks; a publication of such a list follows the editorial content
 *    to the post but keeps serving from /s/lists under its slug.
 */
import { completeMarker, type ListMarker } from "@placemarks/domain";

export interface PivotListRow {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  marker?: ListMarker;
  createdAt: string;
  deleted?: boolean;
}

export interface PivotBlockRow {
  id: string;
  listId: string;
  rank: string;
  kind: "section" | "place";
  refId: string;
  deleted?: boolean;
}

export interface PivotNoteRow {
  id: string;
  targetKey: string;
  deleted?: boolean;
}

export interface PivotAttachmentRow {
  id: string;
  blockId: string;
  deleted?: boolean;
}

export interface PivotPublicationRow {
  id: string;
  target: { kind: string; id: string };
  deleted?: boolean;
}

export interface PivotChanges {
  /** listId → its completed unique marker (every list, live or not). */
  markers: Map<string, ListMarker>;
  /** New posts to create. */
  posts: { id: string; title: string; listId: string }[];
  /** New post blocks to create, in rank order. */
  postBlocks: {
    id: string;
    postId: string;
    rank: string;
    kind: "section" | "place";
    refId: string;
  }[];
  /** List block ids to tombstone (the sections that moved to posts). */
  tombstoneListBlockIds: string[];
  /** noteId → the post it retargets to. */
  retargetNotes: Map<string, string>;
  /** attachmentId → the post block it moves to. */
  moveAttachments: Map<string, string>;
  /** publicationId → the post its target follows. */
  retargetPublications: Map<string, string>;
}

const byRankThenId = <T extends { rank: string; id: string }>(a: T, b: T): number =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const byCreatedThenId = <T extends { createdAt: string; id: string }>(a: T, b: T): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

/**
 * Pivot ids are DERIVED, not random: the same list always yields the same
 * post id (and the same list block the same post block id), so running the
 * pivot twice — the Dexie upgrade on one device, a pre-pivot backup archive
 * restored on another — converges on identical rows instead of duplicates.
 */
export const pivotPostId = (listId: string): string => `${listId}:post`;
export const pivotPostBlockId = (listBlockId: string): string => `${listBlockId}:pb`;

export function pivotGuideLayer(input: {
  lists: PivotListRow[];
  listBlocks: PivotBlockRow[];
  notes: PivotNoteRow[];
  blockNoteAttachments: PivotAttachmentRow[];
  publications?: PivotPublicationRow[];
}): PivotChanges {
  const changes: PivotChanges = {
    markers: new Map(),
    posts: [],
    postBlocks: [],
    tombstoneListBlockIds: [],
    retargetNotes: new Map(),
    moveAttachments: new Map(),
    retargetPublications: new Map(),
  };

  // Deterministic marker assignment order: creation time, id as tiebreaker.
  const assigned: ListMarker[] = [];
  for (const list of [...input.lists].sort(byCreatedThenId)) {
    const partial = list.marker ?? {
      ...(list.color !== undefined ? { color: list.color } : {}),
      ...(list.icon !== undefined ? { icon: list.icon } : {}),
    };
    const marker = completeMarker(partial, list.deleted ? [] : assigned);
    if (!list.deleted) assigned.push(marker);
    changes.markers.set(list.id, marker);
  }

  for (const list of input.lists) {
    if (list.deleted) continue;
    const listBlocks = input.listBlocks
      .filter((b) => b.listId === list.id && !b.deleted)
      .sort(byRankThenId);
    const sectionBlocks = listBlocks.filter((b) => b.kind === "section");
    const placeBlockIds = new Set(listBlocks.filter((b) => b.kind === "place").map((b) => b.id));
    const listNotes = input.notes.filter((n) => !n.deleted && n.targetKey === `list:${list.id}`);
    const listAttachments = input.blockNoteAttachments.filter(
      (a) => !a.deleted && placeBlockIds.has(a.blockId),
    );
    const editorial =
      sectionBlocks.length > 0 || listNotes.length > 0 || listAttachments.length > 0;
    if (!editorial) continue;

    const postId = pivotPostId(list.id);
    changes.posts.push({ id: postId, title: list.name, listId: list.id });
    // The post replicates the guide's whole sequence — sections between the
    // places they narrated; the list keeps only its place blocks.
    const postBlockIdByListBlockId = new Map<string, string>();
    for (const block of listBlocks) {
      const postBlockId = pivotPostBlockId(block.id);
      postBlockIdByListBlockId.set(block.id, postBlockId);
      changes.postBlocks.push({
        id: postBlockId,
        postId,
        rank: block.rank,
        kind: block.kind,
        refId: block.refId,
      });
    }
    for (const block of sectionBlocks) changes.tombstoneListBlockIds.push(block.id);
    for (const note of listNotes) changes.retargetNotes.set(note.id, postId);
    for (const attachment of listAttachments) {
      const moved = postBlockIdByListBlockId.get(attachment.blockId);
      if (moved) changes.moveAttachments.set(attachment.id, moved);
    }
    for (const publication of input.publications ?? []) {
      if (
        !publication.deleted &&
        publication.target.kind === "list" &&
        publication.target.id === list.id
      ) {
        changes.retargetPublications.set(publication.id, postId);
      }
    }
  }

  return changes;
}
