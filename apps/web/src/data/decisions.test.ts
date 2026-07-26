/**
 * The repository's judgements, tested as functions.
 *
 * These lived inside `db.transaction` callbacks, so exercising them meant
 * standing up a Dexie database and driving a whole write path. The identity
 * guard in particular is the one that must never be wrong — it is what stops two
 * PlaceIds forking the same OSM element, and what stops a forged history riding
 * in on an otherwise legitimate relink.
 */
import type { Note, OsmEvidence, Place } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import {
  assertValidPlaceShape,
  attachmentIsValid,
  decidePlaceIdentity,
  listDeletionBlockers,
  membershipBlockers,
  toNoteRow,
  toPlaceRow,
} from "./decisions";

const NOW = "2026-07-20T10:00:00.000Z";
const NODE_1 = { type: "node" as const, id: "1" };
const WAY_9 = { type: "way" as const, id: "9" };

function evidence(ref: { type: "node" | "way" | "relation"; id: string }): OsmEvidence {
  return {
    ref,
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    category: "cafe",
    lat: 51.5,
    lng: -0.12,
    identityTags: {},
    observedAt: NOW,
  };
}

function linked(ref = NODE_1, past: (typeof NODE_1)[] = []): Place {
  return {
    id: "p1",
    origin: "osm",
    currentOsmRef: ref,
    currentOsmLinkedAt: NOW,
    pastOsmRefs: past,
    firstSeen: evidence(ref),
    lastVerified: evidence(ref),
    resolutionState: "resolved",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function unlinked(past: (typeof NODE_1)[] = []): Place {
  return {
    id: "p1",
    origin: "manual",
    pastOsmRefs: past,
    manual: { name: "Picnic bench", lat: 51.5, lng: -0.12 },
    resolutionState: "unlinked",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("decidePlaceIdentity", () => {
  it("accepts a relink that records exactly the ref it replaced", () => {
    const decision = decidePlaceIdentity(linked(NODE_1), linked(WAY_9, [NODE_1]));
    expect(decision.acceptRef).toBe(true);
    expect(decision.pastOsmRefs).toEqual([NODE_1]);
  });

  it("refuses a relink that forgets the ref it replaced", () => {
    const decision = decidePlaceIdentity(linked(NODE_1), linked(WAY_9, []));
    expect(decision.acceptRef).toBe(false);
    expect(decision.pastOsmRefs).toEqual([]);
  });

  it("refuses forged extra history riding on a real transition", () => {
    const forged = { type: "relation" as const, id: "666" };
    const decision = decidePlaceIdentity(linked(NODE_1), linked(WAY_9, [NODE_1, forged]));
    expect(decision.acceptRef).toBe(false);
    expect(decision.pastOsmRefs).toEqual([]);
  });

  it("refuses dropping a former ref", () => {
    const decision = decidePlaceIdentity(linked(WAY_9, [NODE_1]), linked(WAY_9, []));
    expect(decision.pastOsmRefs).toEqual([NODE_1]);
  });

  it("lets an unlinked place record provenance without claiming a binding", () => {
    // How an imported OSM-derived row keeps its ODbL attribution once placed by hand.
    const decision = decidePlaceIdentity(unlinked(), unlinked([NODE_1]));
    expect(decision.acceptRef).toBe(true);
    expect(decision.pastOsmRefs).toEqual([NODE_1]);
  });

  it("is a no-op when nothing about the binding changed", () => {
    const decision = decidePlaceIdentity(linked(NODE_1, [WAY_9]), linked(NODE_1, [WAY_9]));
    expect(decision.acceptRef).toBe(true);
    expect(decision.pastOsmRefs).toEqual([WAY_9]);
  });
});

describe("assertValidPlaceShape", () => {
  it("accepts the two legal shapes", () => {
    expect(() => assertValidPlaceShape(linked())).not.toThrow();
    expect(() => assertValidPlaceShape(unlinked())).not.toThrow();
  });

  it("refuses an OSM-linked place whose evidence describes a different element", () => {
    expect(() =>
      assertValidPlaceShape({ ...linked(NODE_1), lastVerified: evidence(WAY_9) }),
    ).toThrow(/describe the current OSM element/);
  });

  it("refuses an OSM-linked place with no copied evidence", () => {
    const { firstSeen: _dropped, ...rest } = linked();
    expect(() => assertValidPlaceShape(rest as Place)).toThrow(/recovery evidence/);
  });

  it("refuses coordinates outside the world", () => {
    expect(() =>
      assertValidPlaceShape({ ...unlinked(), manual: { name: "x", lat: 91, lng: 0 } }),
    ).toThrow(/latitude\/longitude bounds/);
    expect(() =>
      assertValidPlaceShape({ ...unlinked(), manual: { name: "x", lat: 0, lng: Number.NaN } }),
    ).toThrow(/latitude\/longitude bounds/);
  });
});

describe("row projections", () => {
  it("indexes a place by every ref it has ever been bound to", () => {
    expect(toPlaceRow(linked(WAY_9, [NODE_1])).refKeys?.sort()).toEqual(["node/1", "way/9"]);
  });

  it("indexes a note by its target", () => {
    const note = {
      id: "n1",
      target: { kind: "post", postId: "post-1" },
      body: "",
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    } as Note;
    expect(toNoteRow(note).targetKey).toBe("post:post-1");
  });
});

describe("teardown blockers", () => {
  const embeds = [
    { blockId: "b1", postId: "post-a", postTitle: "A", postListId: "list-1" },
    { blockId: "b2", postId: "post-b", postTitle: "B", postListId: "list-2" },
  ];
  const notes = [{ id: "n1", title: "Field note" }];

  it("removing a place asks about every post that embeds it, and its notes", () => {
    const blockers = membershipBlockers({
      placeId: "p1",
      scope: { kind: "place" },
      embeds,
      notes,
    });
    expect(blockers.map((b) => b.id)).toEqual(["b1", "b2", "n1"]);
  });

  it("removing one membership asks only about that list's posts", () => {
    const blockers = membershipBlockers({
      placeId: "p1",
      scope: { kind: "membership", listId: "list-1", remainingMemberships: 1 },
      embeds,
      notes,
    });
    // post-b is about another list, and the place survives there, so its notes stay.
    expect(blockers.map((b) => b.id)).toEqual(["b1"]);
  });

  it("notes block only the removal that would end the place's existence", () => {
    const last = membershipBlockers({
      placeId: "p1",
      scope: { kind: "membership", listId: "list-1", remainingMemberships: 0 },
      embeds: [],
      notes,
    });
    expect(last.map((b) => b.kind)).toEqual(["note"]);
  });

  it("names a list's posts before its members — deleting posts unblocks the rest", () => {
    const blockers = listDeletionBlockers(
      [{ id: "post-a", title: "A", listId: "list-1", createdAt: NOW, updatedAt: NOW }],
      ["p1", "p2"],
    );
    expect(blockers.map((b) => b.kind)).toEqual(["post", "member", "member"]);
  });
});

describe("attachmentIsValid", () => {
  const note = (overrides: Partial<Note> = {}): Note =>
    ({
      id: "n1",
      target: { kind: "place", placeId: "p1" },
      body: "",
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }) as Note;

  it("requires a place block and a shareable note about the SAME place", () => {
    expect(attachmentIsValid({ block: { kind: "place", refId: "p1" }, note: note() })).toBe(true);
    // A note about a different place.
    expect(attachmentIsValid({ block: { kind: "place", refId: "p2" }, note: note() })).toBe(false);
    // A private note.
    expect(
      attachmentIsValid({
        block: { kind: "place", refId: "p1" },
        note: note({ shareable: false }),
      }),
    ).toBe(false);
    // A section block, which has no place.
    expect(attachmentIsValid({ block: { kind: "section", refId: "n9" }, note: note() })).toBe(
      false,
    );
    expect(attachmentIsValid({ block: undefined, note: note() })).toBe(false);
  });
});
