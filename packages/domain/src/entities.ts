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

export type NoteTarget = { kind: "place"; placeId: PlaceId } | { kind: "list"; listId: string };

/** A rich Markdown page anchored to a place or a list (spec/src/notes.md). */
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
  coverMediaId?: string;
  color?: string;
  icon?: string;
}

export type ListBlockContent =
  | { type: "section"; noteId: string }
  | { type: "place"; placeId: PlaceId };

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
 * confused on `List`/`Note` themselves. The editor bearer token lives in a
 * separate credential record; only its id appears here.
 */
export interface Publication extends BaseEntity {
  target: { kind: "list" | "note"; id: string };
  mode: "snapshot" | "hosted";
  slug?: string; // hosted mode; public and guessable
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
