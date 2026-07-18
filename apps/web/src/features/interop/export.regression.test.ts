import type { List, Note, Place } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { exportListCsv, exportListGeoJson, exportListKml } from "./export";
import { parseGeoJson, parseSavedCsv } from "./parse";

const NOW = "2026-07-18T12:00:00.000Z";
const list: List = { id: "list", name: "Interop", createdAt: NOW, updatedAt: NOW };

function importedPlace(overrides: Partial<Place> = {}): Place {
  return {
    id: "place",
    origin: "import",
    osmRefHistory: [],
    manual: { name: "Prime Meridian", lat: 38, lng: -9 },
    resolutionState: "unlinked",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("interop export regressions", () => {
  it("round-trips integer coordinate fallbacks through Takeout-shaped CSV", () => {
    const csv = exportListCsv(list, [{ place: importedPlace(), notes: [] }]);

    expect(parseSavedCsv(csv, list.name).items[0]?.coords).toEqual({ lat: 38, lng: -9 });
  });

  it("round-trips notes and retained external refs through its GeoJSON interchange format", () => {
    const url = "https://www.google.com/maps/place/example";
    const place = importedPlace({
      externalRefs: [{ provider: "google-maps", url, importedAt: NOW }],
    });
    const note: Note = {
      id: "note",
      target: { kind: "place", placeId: place.id },
      body: "User-authored note",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const geoJson = exportListGeoJson(list, [{ place, notes: [note] }]);
    expect(parseGeoJson(geoJson, list.name).items[0]).toMatchObject({
      note: note.body,
      url,
    });
  });

  it("emits valid XML when a note contains characters forbidden by XML 1.0", () => {
    const place = importedPlace();
    const note: Note = {
      id: "note",
      target: { kind: "place", placeId: place.id },
      body: "before\u0001after",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const document = new DOMParser().parseFromString(
      exportListKml(list, [{ place, notes: [note] }]),
      "application/xml",
    );
    expect(document.querySelector("parsererror")).toBeNull();
  });
});
