/**
 * The repository's decisions, as pure functions.
 *
 * `repo.ts` is a shell over IndexedDB transactions — 28 of them, each declaring
 * its table list up front, with `logMutation` committing alongside the write it
 * records. That transaction boundary is the file's real seam, and it is
 * orthogonal to entities, which is why splitting `repo.ts` *by entity* would cut
 * across it.
 *
 * What can leave are the judgements: given plain rows, what should happen? Those
 * need no database to state and no database to test, and they are the parts where
 * a subtle mistake is expensive — a shape guard that lets a malformed place
 * through, an identity guard that forks a PlaceId, a projection that drops a
 * derived index a query depends on.
 */
import type {
  BlockNoteAttachment,
  List,
  ListBlock,
  Note,
  OsmElementRef,
  Place,
  PlaceId,
  Post,
  PostBlock,
} from "@placemarks/domain";
import { allRefKeys, markerKey, noteTargetKey, refKey, sameRef } from "@placemarks/domain";
import type { ListBlockRow, NoteRow, PlaceRow, PostBlockRow } from "./db";

// ---------- row projections: the derived indexes queries rely on ----------

/** `refKeys` is how a place is found by any OSM element it has ever been bound to. */
export function toPlaceRow(place: Place): PlaceRow {
  return { ...place, refKeys: allRefKeys(place) };
}

/** `targetKey` is how a place's or post's notes are found without a scan. */
export function toNoteRow(note: Note): NoteRow {
  return { ...note, targetKey: noteTargetKey(note.target) };
}

export function toBlockRow(block: ListBlock): ListBlockRow {
  return { ...block, kind: "place", refId: block.content.placeId };
}

export function toPostBlockRow(block: PostBlock): PostBlockRow {
  return {
    ...block,
    kind: block.content.type,
    refId: block.content.type === "section" ? block.content.noteId : block.content.placeId,
  };
}

/** A tombstoned row is absent as far as every read is concerned. */
export const live = <T extends { deleted?: boolean }>(row: T | undefined): T | undefined =>
  row && !row.deleted ? row : undefined;

// ---------- shape: what a persisted place is allowed to look like ----------

function validCoords(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Throws unless the place is one of the two legal shapes: OSM-linked with link
 * time and copied evidence describing the *current* element, or unlinked with
 * owner/import-provided facts. Coordinates are bounds-checked wherever they
 * appear — an out-of-range value renders as a pin somewhere impossible and
 * survives export.
 */
export function assertValidPlaceShape(place: Place): void {
  if (place.currentOsmRef) {
    if (!place.currentOsmLinkedAt || !place.firstSeen || !place.lastVerified) {
      throw new Error("an OSM-linked place requires link time and recovery evidence");
    }
    if (!sameRef(place.lastVerified.ref, place.currentOsmRef)) {
      throw new Error("lastVerified evidence must describe the current OSM element");
    }
    if (place.resolutionState === "unlinked") {
      throw new Error("an OSM-linked place cannot have unlinked resolution state");
    }
  } else if (!place.manual || place.origin === "osm" || place.resolutionState !== "unlinked") {
    throw new Error("a place without an OSM binding requires unlinked manual display facts");
  }
  if (place.manual && !validCoords(place.manual.lat, place.manual.lng)) {
    throw new Error("manual place coordinates are outside valid latitude/longitude bounds");
  }
  for (const evidence of [place.firstSeen, place.lastVerified]) {
    if (evidence && !validCoords(evidence.lat, evidence.lng)) {
      throw new Error("OSM evidence coordinates are outside valid latitude/longitude bounds");
    }
  }
}

// ---------- identity: what an update may change about a place ----------

export interface PlaceIdentityDecision {
  /** The set of former refs to persist. */
  pastOsmRefs: OsmElementRef[];
  /** False when the incoming binding change is refused and the existing one stands. */
  acceptRef: boolean;
}

/**
 * Durable identity is immutable at the repository boundary: `origin` and
 * `firstSeen` never change, and the set of former refs only grows.
 *
 * As a set this is containment plus one rule — a binding transition may add
 * exactly the ref it replaced, and nothing else. (An unlinked place may also
 * record provenance for an element its facts descend from without claiming a
 * binding: that is how an imported OSM-derived row keeps its ODbL attribution
 * after being placed manually.) Anything else is forged history, and the
 * existing values stand.
 */
export function decidePlaceIdentity(existing: Place, incoming: Place): PlaceIdentityDecision {
  const existingPast = new Set(existing.pastOsmRefs.map(refKey));
  const incomingPast = new Set(incoming.pastOsmRefs.map(refKey));
  const preservesPast = [...existingPast].every((key) => incomingPast.has(key));

  const refChanged = !(
    (existing.currentOsmRef === undefined && incoming.currentOsmRef === undefined) ||
    (existing.currentOsmRef !== undefined &&
      incoming.currentOsmRef !== undefined &&
      sameRef(existing.currentOsmRef, incoming.currentOsmRef))
  );
  const added = [...incomingPast].filter((key) => !existingPast.has(key));
  const additionValid =
    added.length === 0 ||
    (refChanged &&
      added.length === 1 &&
      incoming.currentOsmRef !== undefined &&
      existing.currentOsmRef !== undefined &&
      added[0] === refKey(existing.currentOsmRef)) ||
    (existing.currentOsmRef === undefined && incoming.currentOsmRef === undefined);

  return {
    pastOsmRefs: preservesPast && additionValid ? incoming.pastOsmRefs : existing.pastOsmRefs,
    acceptRef:
      !refChanged ||
      existing.currentOsmRef === undefined ||
      (incoming.currentOsmRef !== undefined &&
        preservesPast &&
        additionValid &&
        added.length === 1),
  };
}

// ---------- markers: unique per live list ----------

/** Live markers are unique `(colour, icon)` pairs; a clash is refused, not silently shifted. */
export function markerClashes(marker: List["marker"], otherLiveLists: readonly List[]): boolean {
  const key = markerKey(marker);
  return otherLiveLists.some((list) => markerKey(list.marker) === key);
}

// ---------- teardown: what must be dismantled first ----------

export type BlockerKind = "post" | "member" | "embed" | "note";

export interface Blocker {
  kind: BlockerKind;
  id: string;
  label?: string;
  postId?: string;
  placeId?: PlaceId;
}

/**
 * What blocks a list's deletion: the posts about it, then its remaining members.
 * Posts lead because deleting them is the step that unblocks the rest.
 */
export function listDeletionBlockers(
  posts: readonly Post[],
  memberPlaceIds: readonly PlaceId[],
): Blocker[] {
  return [
    ...posts.map(
      (post): Blocker => ({ kind: "post", id: post.id, label: post.title, postId: post.id }),
    ),
    ...memberPlaceIds.map((placeId): Blocker => ({ kind: "member", id: placeId, placeId })),
  ];
}

/**
 * What blocks removing a place's membership.
 *
 * `scope` is the only difference between the two teardown questions the
 * repository asks, which is why they share one implementation: removing the place
 * asks about every post that embeds it, while removing one membership asks only
 * about that list's posts — and about the place's notes only when this is the last
 * membership, i.e. when the place itself would cease to exist.
 */
export function membershipBlockers(input: {
  placeId: PlaceId;
  scope: { kind: "place" } | { kind: "membership"; listId: string; remainingMemberships: number };
  embeds: readonly { blockId: string; postId: string; postTitle: string; postListId: string }[];
  notes: readonly { id: string; title?: string }[];
}): Blocker[] {
  const { placeId, scope, embeds, notes } = input;
  const blockers: Blocker[] = [];

  for (const embed of embeds) {
    if (scope.kind === "membership" && embed.postListId !== scope.listId) continue;
    blockers.push({
      kind: "embed",
      id: embed.blockId,
      label: embed.postTitle,
      postId: embed.postId,
      placeId,
    });
  }

  const endsExistence = scope.kind === "place" || scope.remainingMemberships === 0;
  if (endsExistence) {
    for (const note of notes) {
      blockers.push({
        kind: "note",
        id: note.id,
        ...(note.title !== undefined ? { label: note.title } : {}),
        placeId,
      });
    }
  }
  return blockers;
}

/** An attachment joins a post place block to a shareable note about the SAME place. */
export function attachmentIsValid(input: {
  block: { kind: string; refId: string } | undefined;
  note: Note | undefined;
}): boolean {
  const { block, note } = input;
  return (
    block?.kind === "place" &&
    note?.shareable === true &&
    note.target.kind === "place" &&
    note.target.placeId === block.refId
  );
}

export type { BlockNoteAttachment };
