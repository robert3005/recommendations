/** The repository's pure decisions — no database required to state or test. */
import type { ListEntry, Place } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import {
  duplicateEntryIds,
  incomingWins,
  NAME_PROXIMITY_METERS,
  nameProximityCandidate,
  stripPlaceRow,
  stripPostRow,
  stripPublicationRow,
  toPlaceRow,
  toPostRow,
  toPublicationRow,
  validCoords,
} from "./decisions";

const NOW = "2026-07-26T12:00:00.000Z";

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: "p1",
    name: "Café Central",
    lat: 38.7139,
    lng: -9.1394,
    origin: "search",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("row projections", () => {
  it("derives the dedup index fields from provenance and strips them back off", () => {
    const source = place({
      googleUrl: "https://www.google.com/maps/place/x/data=!1s0x1A2B:0x3c4D",
      osmRef: { type: "node", id: "101" },
    });
    const row = toPlaceRow(source);
    expect(row.googleFeatureId).toBe("0x1a2b:0x3c4d");
    expect(row.osmKey).toBe("node/101");
    expect(stripPlaceRow(row)).toEqual(source);
  });

  it("indexes nothing for a place without provenance refs", () => {
    const row = toPlaceRow(place());
    expect("googleFeatureId" in row).toBe(false);
    expect("osmKey" in row).toBe(false);
  });

  it("derives and strips post and publication target keys", () => {
    const post = {
      id: "post1",
      target: { kind: "place" as const, placeId: "p1" },
      title: "T",
      body: "",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const postRow = toPostRow(post);
    expect(postRow.targetKey).toBe("place:p1");
    expect(stripPostRow(postRow)).toEqual(post);

    const publication = {
      id: "pub1",
      target: { kind: "list" as const, id: "l1" },
      slug: "lisbon",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const publicationRow = toPublicationRow(publication);
    expect(publicationRow.targetKey).toBe("list:l1");
    expect(stripPublicationRow(publicationRow)).toEqual(publication);
  });
});

describe("coordinates", () => {
  it("accepts the valid range and rejects everything else", () => {
    expect(validCoords(38.7, -9.1)).toBe(true);
    expect(validCoords(90, 180)).toBe(true);
    expect(validCoords(-90, -180)).toBe(true);
    expect(validCoords(90.0001, 0)).toBe(false);
    expect(validCoords(0, -180.0001)).toBe(false);
    expect(validCoords(Number.NaN, 0)).toBe(false);
    expect(validCoords(0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("name + proximity", () => {
  it("matches on normalised name within the proximity radius, nearest first", () => {
    const near = place({ id: "near", lat: 38.714, lng: -9.1394 });
    const nearer = place({ id: "nearer", name: "CAFÉ central!", lat: 38.71391, lng: -9.1394 });
    const far = place({ id: "far", lat: 41.15, lng: -8.61 });
    const found = nameProximityCandidate({ name: "café central", lat: 38.7139, lng: -9.1394 }, [
      near,
      far,
      nearer,
    ]);
    expect(found?.id).toBe("nearer");
  });

  it("never matches an empty normalised name or beyond the radius", () => {
    expect(nameProximityCandidate({ name: "  !! ", lat: 0, lng: 0 }, [place()])).toBeUndefined();
    // ~111 m north of the fixture place at this latitude.
    expect(
      nameProximityCandidate({ name: "Café Central", lat: 38.7149, lng: -9.1394 }, [place()]),
    ).toBeUndefined();
    expect(NAME_PROXIMITY_METERS).toBe(100);
  });
});

describe("archive merge decisions", () => {
  it("newer updatedAt wins; a tie keeps the existing row", () => {
    expect(incomingWins(undefined, { updatedAt: NOW })).toBe(true);
    expect(incomingWins({ updatedAt: NOW }, { updatedAt: "2026-07-27T00:00:00.000Z" })).toBe(true);
    expect(incomingWins({ updatedAt: NOW }, { updatedAt: NOW })).toBe(false);
    expect(incomingWins({ updatedAt: NOW }, { updatedAt: "2026-07-25T00:00:00.000Z" })).toBe(false);
  });

  it("collapses duplicate (listId, placeId) pairs to the (rank, id)-first row", () => {
    const entry = (id: string, rank: string, placeId = "p1"): ListEntry => ({
      id,
      listId: "l1",
      placeId,
      rank,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const drop = duplicateEntryIds([
      entry("e1", "a1"),
      entry("e2", "a0"), // earlier rank — survives
      entry("e3", "a1"), // same rank as e1; e1 has the smaller id
      entry("other", "a5", "p2"), // different pair — untouched
    ]);
    expect(drop.sort()).toEqual(["e1", "e3"]);
  });
});
