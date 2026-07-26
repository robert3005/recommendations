/**
 * The canvas's drawing rules, tested without a map.
 *
 * These were inline in a 726-line component, reachable only by rendering it with
 * a query client, a Dexie repo and a mocked MapLibre — which is why the subtle
 * ones (which marker wins for a place in three lists; a place hiding only when
 * EVERY containing list is toggled off) had no direct coverage.
 */
import type { List, PlaceView } from "@placemarks/domain";
import { markerAt } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_PIN_COLOR } from "../lib/markers";
import type { PlacePinFeature } from "./MapView";
import { boundsOf, fitForProjection, libraryPins } from "./projectionPins";

const NOW = "2026-07-20T10:00:00.000Z";

function list(id: string, markerIndex: number): List {
  return { id, name: id, marker: markerAt(markerIndex), createdAt: NOW, updatedAt: NOW };
}

function place(id: string, lat: number, lng: number, unlinked = true): PlaceView {
  return {
    place: {
      id,
      origin: "manual",
      pastOsmRefs: [],
      manual: { name: id, lat, lng },
      resolutionState: unlinked ? "unlinked" : "resolved",
      createdAt: NOW,
      updatedAt: NOW,
    },
    tags: [],
  } as unknown as PlaceView;
}

describe("libraryPins", () => {
  const lists = [list("l-c", 2), list("l-a", 0), list("l-b", 1)];

  it("gives a place in several lists the lowest list id's marker, badged", () => {
    const [pin] = libraryPins({
      projection: { kind: "all" },
      places: [place("p1", 1, 2)],
      membership: { p1: ["l-c", "l-a", "l-b"] },
      lists,
      hiddenListIds: [],
    });

    // Deterministic across membership order: sorted ids, so l-a wins.
    expect(pin?.color).toBe(markerAt(0).color);
    expect(pin?.multi).toBe(true);
  });

  it("hides a place only when EVERY list containing it is toggled off", () => {
    const input = {
      projection: { kind: "all" as const },
      places: [place("p1", 1, 2)],
      membership: { p1: ["l-a", "l-b"] },
      lists,
      hiddenListIds: ["l-a"],
    };
    expect(libraryPins(input)).toHaveLength(1);
    expect(libraryPins({ ...input, hiddenListIds: ["l-a", "l-b"] })).toHaveLength(0);
  });

  it("uses the projected list's marker, not another membership's", () => {
    const [pin] = libraryPins({
      projection: { kind: "list", listId: "l-b" },
      places: [place("p1", 1, 2)],
      membership: { p1: ["l-a", "l-b"] },
      lists,
      hiddenListIds: [],
    });

    // l-a sorts first, but the projection is l-b's.
    expect(pin?.color).toBe(markerAt(1).color);
    expect(pin?.multi).toBe(false);
  });

  it("shows a post's embeds solid and only the editor's candidates dimmed", () => {
    const base = {
      places: [place("embedded", 1, 2), place("candidate", 3, 4), place("elsewhere", 5, 6)],
      membership: { embedded: ["l-a"], candidate: ["l-a"], elsewhere: ["l-b"] },
      lists,
      hiddenListIds: [],
      postListId: "l-a",
      focusPlaceIds: new Set(["embedded"]),
    };

    // Reading: embeds only.
    const reading = libraryPins({ ...base, projection: { kind: "post", postId: "post-1" } });
    expect(reading.map((pin) => pin.placeId)).toEqual(["embedded"]);

    // Editing: the rest of the post's list joins, dimmed; other lists do not.
    const editing = libraryPins({
      ...base,
      projection: { kind: "post", postId: "post-1", editing: true },
      candidatePlaceIds: new Set(["candidate"]),
    });
    expect(editing.map((pin) => pin.placeId)).toEqual(["embedded", "candidate"]);
    expect(editing.find((pin) => pin.placeId === "embedded")?.dimmed).toBe(false);
    expect(editing.find((pin) => pin.placeId === "candidate")?.dimmed).toBe(true);
  });

  it("marks a place belonging to no live list with the transient colour", () => {
    const [pin] = libraryPins({
      projection: { kind: "list", listId: "l-a" },
      places: [place("orphan", 1, 2)],
      membership: {},
      lists,
      hiddenListIds: [],
    });
    expect(pin?.color).toBe(DEFAULT_PIN_COLOR);
    expect(pin?.unlinked).toBe(true);
  });
});

describe("boundsOf", () => {
  it("widens a single point to a non-degenerate box", () => {
    const bounds = boundsOf([{ lat: 10, lng: 20 }]);
    expect((bounds?.east ?? 0) - (bounds?.west ?? 0)).toBeCloseTo(0.002);
    expect((bounds?.north ?? 0) - (bounds?.south ?? 0)).toBeCloseTo(0.002);
  });

  it("is null for no points, so the camera is never yanked to a default", () => {
    expect(boundsOf([])).toBeNull();
  });
});

describe("fitForProjection", () => {
  const pin = (placeId: string, lat: number, lng: number, dimmed: boolean): PlacePinFeature => ({
    placeId,
    name: placeId.toUpperCase(),
    lat,
    lng,
    color: "#000000",
    icon: "circle",
    unlinked: false,
    multi: false,
    dimmed,
  });
  const pins = [pin("a", 1, 2, false), pin("b", 5, 6, true)];

  it("frames only the undimmed pins of a list", () => {
    const fit = fitForProjection({
      projection: { kind: "list", listId: "l-1" },
      placePins: pins,
      markPins: [],
    });
    expect(fit?.key).toBe("list:l-1");
    // b is dimmed, so the box is a's widened point, not a's-to-b's span.
    expect(fit?.bounds.north).toBeCloseTo(1.001);
  });

  it("keys a post's follow camera by the section in view, so scrolling re-frames", () => {
    const first = fitForProjection({
      projection: { kind: "post", postId: "p", focusPlaceIds: ["a"] },
      placePins: pins,
      markPins: [],
    });
    const second = fitForProjection({
      projection: { kind: "post", postId: "p", focusPlaceIds: ["b"] },
      placePins: pins,
      markPins: [],
    });
    expect(first?.key).not.toBe(second?.key);
    // A focused embed frames even when dimmed for the article's sake.
    expect(second?.bounds.north).toBeCloseTo(5.001);
  });

  it("does not frame a review with no loaded item, or the settings route", () => {
    expect(
      fitForProjection({ projection: { kind: "review" }, placePins: pins, markPins: [] }),
    ).toBeNull();
    expect(
      fitForProjection({ projection: { kind: "settings" }, placePins: pins, markPins: [] }),
    ).toBeNull();
  });
});
