/** Owned personal entities — see book/src/data-model.md. */
import type { PlaceId } from "./place";

interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

/** The user's decision to keep a place. At most one live SavedPlace per PlaceId. */
export interface SavedPlace extends BaseEntity {
  placeId: PlaceId;
}

export interface Tag extends BaseEntity {
  name: string; // display casing preserved
  nameNorm: string; // normalized for uniqueness
  color?: string;
}

/** Independently mergeable edge; one live assignment per (savedPlaceId, tagId). */
export interface TagAssignment extends BaseEntity {
  savedPlaceId: string;
  tagId: string;
}

export type NoteTarget = { kind: "place"; placeId: PlaceId } | { kind: "list"; listId: string };

/** A rich Markdown page anchored to a place or a list (book/src/notes.md). */
export interface Note extends BaseEntity {
  target: NoteTarget;
  title?: string;
  body: string; // CommonMark + GFM source of truth
  mediaIds: string[];
  shareable: boolean; // eligibility only; default false
}

export function noteTargetKey(target: NoteTarget): string {
  return target.kind === "place" ? `place:${target.placeId}` : `list:${target.listId}`;
}

export interface MediaAsset extends BaseEntity {
  mime: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
  localBlobKey: string; // binary bytes live in the media blob store, not the domain object
  hostedMediaId?: string;
}

export interface List extends BaseEntity {
  name: string;
  description?: string;
  coverMediaId?: string;
  color?: string;
  icon?: string;
}

export type ListBlockContent =
  | { type: "section"; noteId: string }
  | { type: "place"; savedPlaceId: string };

/** Blocks are their own entities so reordering one item never replaces a whole array. */
export interface ListBlock extends BaseEntity {
  listId: string;
  rank: string; // sortable fractional rank
  content: ListBlockContent;
}

/** Explicit durable edge: a shareable place note attached to a place block. */
export interface BlockNoteAttachment extends BaseEntity {
  blockId: string;
  noteId: string;
  rank: string;
}

/** Deterministic ordering: rank, then id as the tiebreaker. */
export function compareByRank<T extends { rank: string; id: string }>(a: T, b: T): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
