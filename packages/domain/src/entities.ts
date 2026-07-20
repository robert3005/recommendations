/** Owned personal entities — see spec/src/data-model.md. */
import type { PlaceId } from "./place";

interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface Tag extends BaseEntity {
  name: string; // display casing preserved
  nameNorm: string; // normalized for uniqueness
  color?: string;
}

/** Independently mergeable edge; one live assignment per (placeId, tagId). */
export interface TagAssignment extends BaseEntity {
  placeId: PlaceId;
  tagId: string;
}

/**
 * A note anchors to a place or a post (spec/src/data-model.md — the 2026-07-19
 * pivot retargeted list notes to posts).
 */
export type NoteTarget = { kind: "place"; placeId: PlaceId } | { kind: "post"; postId: string };

/** A rich Markdown page anchored to a place or a post (spec/src/notes.md). */
export interface Note extends BaseEntity {
  target: NoteTarget;
  title?: string;
  body: string; // CommonMark + GFM source of truth
  mediaIds: string[];
  shareable: boolean; // eligibility only; default false
}

export function noteTargetKey(target: NoteTarget): string {
  return target.kind === "place" ? `place:${target.placeId}` : `post:${target.postId}`;
}

export interface MediaAsset extends BaseEntity {
  mime: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
  localBlobKey: string; // binary bytes live in the media blob store, not the domain object
  hostedMediaId?: string;
}

/**
 * A list's unique marker — a (colour, icon) pair its places wear on the map
 * (spec/src/data-model.md §List: colour alone runs out of legible distinctions
 * on the all-lists canvas). The repository keeps live markers unique.
 */
export interface ListMarker {
  color: string; // palette colour
  icon: string; // symbol from the app's marker icon set
}

/**
 * A named, marked, ordered group of places — nothing more (2026-07-19: section
 * blocks moved to posts; editorial prose lives on Post, never on List). A list
 * may be empty: membership-is-existence constrains places, not lists.
 */
export interface List extends BaseEntity {
  name: string;
  marker: ListMarker; // unique per live list; worn by its places' pins on the map
  coverMediaId?: string;
}

/** List blocks carry membership only (2026-07-19 pivot). */
export type ListBlockContent = { type: "place"; placeId: PlaceId };

/** Blocks are their own entities so reordering one item never replaces a whole array. */
export interface ListBlock extends BaseEntity {
  listId: string;
  rank: string; // sortable fractional rank
  content: ListBlockContent;
}

/**
 * A post — the editorial layer (spec/src/posts.md): an article about exactly
 * one list, interleaving Markdown sections with embeds of that list's places.
 */
export interface Post extends BaseEntity {
  title: string;
  listId: string; // the list this post editorialises
  coverMediaId?: string;
}

export type PostBlockContent =
  | { type: "section"; noteId: string } // a post-targeted note
  | { type: "place"; placeId: PlaceId }; // an embed of a member of the post's list

export interface PostBlock extends BaseEntity {
  postId: string;
  rank: string; // sortable fractional rank
  content: PostBlockContent;
}

/** Explicit durable edge: a shareable place note attached to a post place block. */
export interface BlockNoteAttachment extends BaseEntity {
  blockId: string; // must identify a post place block
  noteId: string;
  rank: string;
}

/** Explicit durable edge: a tag selected for publication on a post place block. */
export interface BlockTagSelection extends BaseEntity {
  blockId: string; // must identify a post place block
  tagId: string; // tag assigned to that block's place
}

/** Deterministic ordering: rank, then id as the tiebreaker. */
export function compareByRank<T extends { rank: string; id: string }>(a: T, b: T): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type PublicationStatus =
  | "draft"
  | "queued"
  | "publishing"
  | "published"
  | "failed"
  | "revoking"
  | "revoked";

/**
 * Private publication state (spec/src/data-model.md §Publication state) —
 * public content, local drafts, credentials, retries, and revocation are never
 * confused on `List`/`Post`/`Note` themselves. The editor bearer token lives in
 * a separate credential record; only its id appears here.
 */
export interface Publication extends BaseEntity {
  target: { kind: "list" | "post" | "note"; id: string };
  mode: "snapshot" | "hosted";
  slug?: string; // hosted mode; public and guessable
  /**
   * The share-service path segment this publication's slug lives under.
   * Pre-pivot guide documents migrated onto posts keep serving from
   * `/s/lists` under their original slugs (spec/src/sharing.md §Share service);
   * absent means the segment implied by `target.kind`.
   */
  channel?: "lists" | "posts" | "notes";
  credentialId?: string;
  status: PublicationStatus;
  localRevision: string;
  lastPublishedLocalRevision?: string;
  publishedRevision?: number; // server revision / ETag value
  lastPublishedHash?: string;
  publishedAt?: string;
  lastError?: string;
}

/** A device-held editor bearer token — never in a public URL or document. */
export interface EditorCredential extends BaseEntity {
  /** ≥256 random bits, base64url. Sent over TLS; the server stores only a hash. */
  token: string;
}
