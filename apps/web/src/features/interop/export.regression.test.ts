import {
  createOsmPlace,
  type List,
  type Note,
  type Place,
  type PoiResolver,
  type ResolvedPoi,
  type SearchProvider,
} from "@placemarks/domain";
import Papa from "papaparse";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportListCsv, exportListGeoJson, exportListKml } from "./export";
import { runImport } from "./importer";
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
  it("formula-escapes dangerous Takeout CSV title, note, and address cells", () => {
    for (const prefix of ["=", "+", "-", "@"]) {
      const place = importedPlace({
        manual: {
          name: `${prefix}title`,
          lat: 38,
          lng: -9,
          address: `${prefix}address`,
        },
      });
      const note: Note = {
        id: `note-${prefix}`,
        target: { kind: "place", placeId: place.id },
        body: `${prefix}note`,
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };

      const csv = exportListCsv(list, [{ place, notes: [note] }]);
      const row = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
        .data[0];
      expect.soft(row?.Title).toBe(`'${prefix}title`);
      expect.soft(row?.Note).toBe(`'${prefix}note`);
      expect.soft(row?.Address).toBe(`'${prefix}address`);
    }
  });

  it("recognizes an exported OSM portal URL directly instead of geocoding or labeling it Google", async () => {
    const poi: ResolvedPoi = {
      osmRef: { type: "node", id: "101" },
      name: "Café Central",
      category: "cafe",
      lat: 38.7139,
      lng: -9.1394,
      address: "Rua Example 12, Lisboa",
      identityTags: { amenity: "cafe", name: "Café Central" },
      resolvedAt: NOW,
    };
    const csv = exportListCsv(list, [{ place: createOsmPlace("linked", poi, NOW), notes: [] }]);
    const search: SearchProvider = {
      search: vi.fn(async () => [
        {
          ref: poi.osmRef,
          name: poi.name ?? "Café Central",
          lat: poi.lat,
          lng: poi.lng,
          category: poi.category,
          address: poi.address,
        },
      ]),
    };
    const resolver: PoiResolver = {
      resolveExact: vi.fn(async () => ({ type: "ok" as const, poi })),
      searchNearby: vi.fn(async () => []),
      discover: vi.fn(async () => ({ pois: [], truncated: false })),
    };
    const repo = new DexieRepository(`csv-osm-roundtrip-${crypto.randomUUID()}`);

    try {
      const report = await runImport(
        repo,
        { name: "linked.csv", bytes: new TextEncoder().encode(csv) },
        { search, resolver },
        NOW,
      );

      expect.soft(search.search).not.toHaveBeenCalled();
      expect.soft(resolver.resolveExact).toHaveBeenCalledWith(poi.osmRef);
      expect.soft(report).toMatchObject({ placed: 1, linked: 1, review: 0 });
      const imported = (await repo.listPlaces())[0]?.place;
      expect.soft(imported?.currentOsmRef).toEqual(poi.osmRef);
      expect.soft(imported?.externalRefs ?? []).not.toContainEqual(
        expect.objectContaining({
          provider: "google-maps",
          url: "https://www.openstreetmap.org/node/101",
        }),
      );
    } finally {
      repo.db.close();
    }
  });

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
