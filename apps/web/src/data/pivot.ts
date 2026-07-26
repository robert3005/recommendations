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
import { completeMarker, type ListMarker, markerKey } from "@placemarks/domain";

export interface PivotListRow {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  marker?: ListMarker;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export type PivotBlockContent =
  | { type: "section"; noteId: string }
  | { type: "place"; placeId: string };

export interface PivotBlockRow {
  id: string;
  listId: string;
  rank: string;
  /** Canonical edge. `kind`/`refId` are query indexes and are never trusted. */
  content: PivotBlockContent;
  kind?: "section" | "place";
  refId?: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface PivotNoteRow {
  id: string;
  /** Canonical target. `targetKey` is a query index and is never trusted. */
  target: { kind: string; listId?: string; placeId?: string; postId?: string };
  targetKey?: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface PivotAttachmentRow {
  id: string;
  blockId: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface PivotPublicationRow {
  id: string;
  target: { kind: string; id: string };
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface PivotChanges {
  /** listId → its completed unique marker (every list, live or not). */
  markers: Map<string, ListMarker>;
  /** New posts to create. */
  posts: {
    id: string;
    title: string;
    listId: string;
    createdAt: string;
    updatedAt: string;
  }[];
  /** New post blocks to create, in rank order. */
  postBlocks: {
    id: string;
    postId: string;
    rank: string;
    content: PivotBlockContent;
    createdAt: string;
    updatedAt: string;
  }[];
  /** List block id → stable structural-tombstone time. */
  tombstoneListBlocks: Map<string, string>;
  /** noteId → the post it retargets to and stable structural-change time. */
  retargetNotes: Map<string, { postId: string; updatedAt: string }>;
  /** attachmentId → the post block it moves to and stable structural-change time. */
  moveAttachments: Map<string, { blockId: string; updatedAt: string }>;
  /** publicationId → the post its target follows and stable structural-change time. */
  retargetPublications: Map<string, { postId: string; updatedAt: string }>;
}

const byRankThenId = <T extends { rank: string; id: string }>(a: T, b: T): number =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const byCreatedThenId = <T extends { createdAt: string; id: string }>(a: T, b: T): number =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/**
 * Same-id schema rewrites must sort strictly after their legacy source row,
 * while remaining identical on every device and for every export of the same
 * source library. Invocation/export wall time is therefore never used.
 */
export function stablePivotSuccessor(timestamp: string): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new Error(`pivot source carries an invalid timestamp: ${timestamp}`);
  }
  const next = new Date(millis + 1);
  if (!Number.isFinite(next.getTime())) {
    throw new Error(`pivot source timestamp has no representable successor: ${timestamp}`);
  }
  return next.toISOString();
}

export function canonicalPivotBlock(block: PivotBlockRow): PivotBlockContent {
  if (block.content?.type === "place" && typeof block.content.placeId === "string") {
    return { type: "place", placeId: block.content.placeId };
  }
  if (block.content?.type === "section" && typeof block.content.noteId === "string") {
    return { type: "section", noteId: block.content.noteId };
  }
  throw new Error(`list block ${block.id} has no canonical content — pivot refused`);
}

export function pivotBlockIndex(content: PivotBlockContent): {
  kind: PivotBlockContent["type"];
  refId: string;
} {
  return {
    kind: content.type,
    refId: content.type === "section" ? content.noteId : content.placeId,
  };
}

export function pivotNoteTargetKey(target: PivotNoteRow["target"]): string {
  if (target?.kind === "list" && typeof target.listId === "string") {
    return `list:${target.listId}`;
  }
  if (target?.kind === "place" && typeof target.placeId === "string") {
    return `place:${target.placeId}`;
  }
  if (target?.kind === "post" && typeof target.postId === "string") {
    return `post:${target.postId}`;
  }
  throw new Error("note has no canonical target — pivot refused");
}

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
    tombstoneListBlocks: new Map(),
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
    if (!list.deleted) {
      if (assigned.some((current) => markerKey(current) === markerKey(marker))) {
        throw new Error(
          "list marker capacity is exhausted — migration refused before writing a duplicate marker",
        );
      }
      assigned.push(marker);
    }
    changes.markers.set(list.id, marker);
  }

  for (const list of input.lists) {
    if (list.deleted) continue;
    const listBlocks = input.listBlocks
      .filter((b) => b.listId === list.id && !b.deleted)
      .sort(byRankThenId)
      .map((block) => ({ block, content: canonicalPivotBlock(block) }));
    const sectionBlocks = listBlocks.filter(({ content }) => content.type === "section");
    const placeBlockIds = new Set(
      listBlocks.filter(({ content }) => content.type === "place").map(({ block }) => block.id),
    );
    const listNotes = input.notes.filter(
      (note) => !note.deleted && note.target.kind === "list" && note.target.listId === list.id,
    );
    const listAttachments = input.blockNoteAttachments.filter(
      (a) => !a.deleted && placeBlockIds.has(a.blockId),
    );
    const editorial =
      sectionBlocks.length > 0 || listNotes.length > 0 || listAttachments.length > 0;
    if (!editorial) continue;

    const postId = pivotPostId(list.id);
    changes.posts.push({
      id: postId,
      title: list.name,
      listId: list.id,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
    });
    // The post replicates the guide's whole sequence — sections between the
    // places they narrated; the list keeps only its place blocks.
    const postBlockIdByListBlockId = new Map<string, string>();
    for (const { block, content } of listBlocks) {
      const postBlockId = pivotPostBlockId(block.id);
      postBlockIdByListBlockId.set(block.id, postBlockId);
      changes.postBlocks.push({
        id: postBlockId,
        postId,
        rank: block.rank,
        content,
        createdAt: block.createdAt,
        updatedAt: block.updatedAt,
      });
    }
    for (const { block } of sectionBlocks) {
      changes.tombstoneListBlocks.set(block.id, stablePivotSuccessor(block.updatedAt));
    }
    for (const note of listNotes) {
      changes.retargetNotes.set(note.id, {
        postId,
        updatedAt: stablePivotSuccessor(note.updatedAt),
      });
    }
    for (const attachment of listAttachments) {
      const moved = postBlockIdByListBlockId.get(attachment.blockId);
      if (moved) {
        changes.moveAttachments.set(attachment.id, {
          blockId: moved,
          updatedAt: stablePivotSuccessor(attachment.updatedAt),
        });
      }
    }
    for (const publication of input.publications ?? []) {
      if (
        !publication.deleted &&
        publication.target.kind === "list" &&
        publication.target.id === list.id
      ) {
        changes.retargetPublications.set(publication.id, {
          postId,
          updatedAt: stablePivotSuccessor(publication.updatedAt),
        });
      }
    }
  }

  return changes;
}
