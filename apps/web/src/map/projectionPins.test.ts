/**
 * The canvas's drawing rules, tested without a map: which marker a place in
 * several lists wears, when a home toggle hides a place, which places a post
 * projects, and which bounds a camera move frames.
 */
import type { List } from "@placemarks/domain";
import { ACCENT_COLORS, MARKER_SHAPES } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import {
  boundsOf,
  DEFAULT_PUBLISHED_MARKER,
  fitForProjection,
  importItemMarks,
  libraryPins,
  type ProjectablePlace,
  publishedPins,
} from "./projectionPins";

const NOW = "2026-07-26T10:00:00.000Z";

function list(id: string, markerIndex: number): List {
  return {
    id,
    name: id,
    marker: {
      shape: MARKER_SHAPES[markerIndex % 8] as List["marker"]["shape"],
      color: (ACCENT_COLORS[markerIndex % 8] as { fill: string }).fill,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function place(id: string, lat: number, lng: number, listIds: string[]): ProjectablePlace {
  return { place: { id, name: id.toUpperCase(), lat, lng }, listIds };
}

const lists = [list("l-a", 0), list("l-b", 1), list("l-c", 2)];

describe("libraryPins — lists overlay", () => {
  it("gives a place in several lists the lowest list id's marker, stacked and counted", () => {
    const [pin] = libraryPins({
      projection: { kind: "lists-overlay" },
      places: [place("p1", 1, 2, ["l-c", "l-a", "l-b"])],
      lists,
      hiddenListIds: [],
    });

    // Deterministic across membership order: sorted ids, so l-a leads.
    expect(pin?.marker).toEqual(lists[0]?.marker);
    expect(pin?.stackedMarker).toEqual(lists[1]?.marker);
    expect(pin?.listCount).toBe(3);
    expect(pin?.dimmed).toBe(false);
  });

  it("hides a place only when EVERY list containing it is toggled off", () => {
    const input = {
      projection: { kind: "lists-overlay" } as const,
      places: [place("p1", 1, 2, ["l-a", "l-b"])],
      lists,
      hiddenListIds: ["l-a"],
    };
    expect(libraryPins(input)).toHaveLength(1);
    expect(libraryPins({ ...input, hiddenListIds: ["l-a", "l-b"] })).toHaveLength(0);
  });

  it("does not let a hidden list lend its marker to a still-visible place", () => {
    const [pin] = libraryPins({
      projection: { kind: "lists-overlay" },
      places: [place("p1", 1, 2, ["l-a", "l-b"])],
      lists,
      hiddenListIds: ["l-a"],
    });
    expect(pin?.marker).toEqual(lists[1]?.marker);
    expect(pin?.listCount).toBe(1);
    expect(pin?.stackedMarker).toBeUndefined();
  });
});

describe("libraryPins — list projection", () => {
  it("shows members solid in the list's marker and the rest of the library dimmed", () => {
    const pins = libraryPins({
      projection: { kind: "list", listId: "l-b" },
      places: [place("member", 1, 2, ["l-a", "l-b"]), place("other", 3, 4, ["l-a"])],
      lists,
      hiddenListIds: [],
    });

    const member = pins.find((pin) => pin.placeId === "member");
    const other = pins.find((pin) => pin.placeId === "other");
    // l-a sorts first, but the projection is l-b's.
    expect(member?.marker).toEqual(lists[1]?.marker);
    expect(member?.dimmed).toBe(false);
    expect(other?.dimmed).toBe(true);
    expect(other?.marker).toEqual(lists[0]?.marker);
  });
});

describe("libraryPins — post projection", () => {
  it("projects exactly the target's places, wearing the target list's marker", () => {
    const pins = libraryPins({
      projection: { kind: "post", postId: "post-1" },
      places: [place("member", 1, 2, ["l-b"]), place("elsewhere", 3, 4, ["l-a"])],
      lists,
      hiddenListIds: [],
      postTargetPlaceIds: new Set(["member"]),
      postListId: "l-b",
    });

    expect(pins.map((pin) => pin.placeId)).toEqual(["member"]);
    expect(pins[0]?.marker).toEqual(lists[1]?.marker);
    expect(pins[0]?.dimmed).toBe(false);
  });

  it("projects a place post's one place without a list marker to borrow", () => {
    const pins = libraryPins({
      projection: { kind: "post", postId: "post-2" },
      places: [place("solo", 1, 2, ["l-c"])],
      lists,
      hiddenListIds: [],
      postTargetPlaceIds: new Set(["solo"]),
    });
    expect(pins).toHaveLength(1);
    expect(pins[0]?.marker).toEqual(lists[2]?.marker);
  });
});

describe("publishedPins and importItemMarks", () => {
  it("dresses a published list's places in the document's marker", () => {
    const marker = lists[2]?.marker as List["marker"];
    const pins = publishedPins({
      kind: "published-doc",
      docKey: "list:lisbon",
      marker,
      places: [{ id: "pp-1", name: "Café", lat: 1, lng: 2 }],
    });
    expect(pins[0]).toMatchObject({ placeId: "pp-1", marker, dimmed: false });
  });

  it("falls back to the default marker for post documents", () => {
    const pins = publishedPins({
      kind: "published-doc",
      docKey: "post:weekend",
      places: [{ id: "pp-1", name: "Café", lat: 1, lng: 2 }],
    });
    expect(pins[0]?.marker).toEqual(DEFAULT_PUBLISHED_MARKER);
  });

  it("labels the item's own coordinates and its candidates deterministically", () => {
    const marks = importItemMarks({
      kind: "import-item",
      itemId: "item-1",
      title: "Imported café",
      coords: { lat: 1, lng: 2 },
      candidates: [
        { key: "c-1", name: "First", lat: 3, lng: 4 },
        { key: "c-2", name: "Second", lat: 5, lng: 6 },
      ],
    });
    expect(marks.map((mark) => mark.label)).toEqual(["•", "A", "B"]);
    expect(marks[0]?.key).toBe("item-1:imported");
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
  const pin = (placeId: string, lat: number, lng: number, dimmed: boolean) => ({
    placeId,
    name: placeId.toUpperCase(),
    lat,
    lng,
    marker: lists[0]?.marker as List["marker"],
    listCount: 1,
    dimmed,
  });
  const pins = [pin("a", 1, 2, false), pin("b", 5, 6, true)];

  it("never frames the lists overlay — the home keeps the persisted viewport", () => {
    expect(
      fitForProjection({ projection: { kind: "lists-overlay" }, placePins: pins, markPins: [] }),
    ).toBeNull();
  });

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

  it("keys a post's follow camera by the mentions in view, so scrolling re-frames", () => {
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
    expect(second?.bounds.north).toBeCloseTo(5.001);
  });

  it("frames an import item by its marks, keyed by the item", () => {
    const fit = fitForProjection({
      projection: {
        kind: "import-item",
        itemId: "item-1",
        title: "Imported café",
        candidates: [{ key: "c-1", name: "First", lat: 3, lng: 4 }],
      },
      placePins: [],
      markPins: [{ key: "c-1", name: "First", label: "A", lat: 3, lng: 4 }],
    });
    expect(fit?.key).toBe("import-item:item-1");
  });

  it("frames a published document by its pins, narrowed by the viewer's focus", () => {
    const all = fitForProjection({
      projection: {
        kind: "published-doc",
        docKey: "list:lisbon",
        places: [{ id: "a", name: "A", lat: 1, lng: 2 }],
      },
      placePins: pins,
      markPins: [],
    });
    const focused = fitForProjection({
      projection: {
        kind: "published-doc",
        docKey: "list:lisbon",
        places: [{ id: "a", name: "A", lat: 1, lng: 2 }],
        focusPlaceIds: ["b"],
      },
      placePins: pins,
      markPins: [],
    });
    expect(all?.key).toBe("list:lisbon");
    expect(focused?.key).toBe("list:lisbon:b");
    expect(focused?.bounds.north).toBeCloseTo(5.001);
  });
});
