/**
 * Phase 3 adherence checks derived from the current book/src/interop.md.
 *
 * These intentionally exercise the interchange contract rather than private
 * implementation details: Takeout joins by Google id, KML folders/styles become
 * lists/markers, a user's renamed list remains canonical on re-import, placed
 * imports opportunistically link to OSM, GeoJSON carries portable metadata, and
 * OSM-derived exports carry attribution.
 */
import {
  createOsmPlace,
  type List,
  type PoiResolver,
  type ResolvedPoi,
  type SearchProvider,
  type Tag,
} from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";
import Papa from "papaparse";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { type ExportPlaceView, exportListCsv, exportListGeoJson } from "./export";
import { runImport } from "./importer";
import { parseImportFile, parseTakeoutZip } from "./parse";

const NOW = "2026-07-19T10:00:00.000Z";

const list: List = {
  id: "list-1",
  name: "Lisbon",
  color: "#dc2626",
  createdAt: NOW,
  updatedAt: NOW,
};

function poi(overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    phone: "+351 210 000 000",
    openingHours: "Mo-Su 08:00-20:00",
    identityTags: { amenity: "cafe", name: "Café Central" },
    resolvedAt: NOW,
    ...overrides,
  };
}

function deps(match: ResolvedPoi = poi()): {
  search: SearchProvider;
  resolver: PoiResolver;
} {
  return {
    search: { search: vi.fn(async () => []) },
    resolver: {
      resolveExact: vi.fn(async (ref) =>
        ref.type === match.osmRef.type && ref.id === match.osmRef.id
          ? { type: "ok" as const, poi: match }
          : { type: "gone" as const },
      ),
      searchNearby: vi.fn(async () => [match]),
      discover: vi.fn(async () => ({ pois: [], truncated: false })),
    },
  };
}

describe("Phase 3 Takeout/list identity contract", () => {
  it("does not cross-reference Saved Places geometry by title when the CSV row has no Google id", () => {
    const csv = ["Title,Note,URL,Address", '"Common Name",,,"Somewhere else"'].join("\n");
    const saved = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
          properties: {
            Title: "Common Name",
          },
        },
      ],
    });
    const parsed = parseTakeoutZip(
      zipSync({
        "Takeout/Saved/Lisbon.csv": strToU8(csv),
        "Takeout/Maps (your places)/Saved Places.json": strToU8(saved),
      }),
    );
    expect(parsed.lists.find((entry) => entry.name === "Lisbon")?.items[0]?.coords).toBeUndefined();
  });

  it("re-imports into a list the user renamed instead of recreating the source-named list", async () => {
    const repo = new DexieRepository(`phase3-renamed-list-${crypto.randomUUID()}`);
    const csv = [
      "Title,Note,URL,Address",
      '"Dropped pin",,"https://www.google.com/maps/search/38.71,-9.15",',
    ].join("\n");
    const file = { name: "Google favourites.csv", bytes: strToU8(csv) };

    try {
      await runImport(repo, file, deps(), NOW);
      const original = (await repo.listLists())[0];
      if (!original) throw new Error("import did not create its list");
      await repo.updateList({ ...original, name: "My edited Lisbon list", updatedAt: NOW });

      await runImport(repo, file, deps(), NOW);

      expect(await repo.listLists()).toEqual([
        expect.objectContaining({ id: original.id, name: "My edited Lisbon list" }),
      ]);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 KML and OSM-linking contract", () => {
  it("turns KML folders into separate source lists and retains their marker styles", async () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Style id="red"><IconStyle><color>ff0000ff</color></IconStyle></Style>
  <Folder><name>Food</name>
    <Placemark><name>Café</name><styleUrl>#red</styleUrl><Point><coordinates>-9.1,38.7</coordinates></Point></Placemark>
  </Folder>
  <Folder><name>Views</name>
    <Placemark><name>Miradouro</name><Point><coordinates>-9.2,38.8</coordinates></Point></Placemark>
  </Folder>
</Document></kml>`;

    const parsed = await parseImportFile({ name: "trip.kml", bytes: strToU8(kml) });

    expect(parsed.lists.map((entry) => entry.name)).toEqual(["Food", "Views"]);
    expect((parsed.lists[0] as (typeof parsed.lists)[number] & { color?: string }).color).toBe(
      "#ff0000",
    );
  });

  it("opportunistically OSM-links a coordinate-bearing import when one high-confidence nearby match exists", async () => {
    const repo = new DexieRepository(`phase3-coordinate-match-${crypto.randomUUID()}`);
    const match = poi();
    const providers = deps(match);
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [match.lng, match.lat] },
          properties: { name: match.name, category: match.category },
        },
      ],
    });

    try {
      const report = await runImport(
        repo,
        { name: "placed.geojson", bytes: strToU8(geojson) },
        providers,
        NOW,
      );

      expect(providers.resolver.searchNearby).toHaveBeenCalled();
      expect(report.linked).toBe(1);
      expect((await repo.listPlaces())[0]?.place.currentOsmRef).toEqual(match.osmRef);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 export portability and licensing contract", () => {
  it("carries phone, hours, and tags in the GeoJSON interchange format", () => {
    const place = createOsmPlace("place-1", poi(), NOW);
    const tags: Tag[] = [
      {
        id: "tag-1",
        name: "Coffee",
        nameNorm: "coffee",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const view = { place, notes: [], tags } as ExportPlaceView & { tags: Tag[] };
    const properties = (
      JSON.parse(exportListGeoJson(list, [view])) as {
        features: Array<{ properties: Record<string, unknown> }>;
      }
    ).features[0]?.properties;

    expect(properties).toMatchObject({
      phone: "+351 210 000 000",
      openingHours: "Mo-Su 08:00-20:00",
      tags: ["Coffee"],
    });
  });

  it("round-trips an exported GeoJSON OSM anchor into a linked place in an empty library", async () => {
    const match = poi();
    const place = createOsmPlace("place-1", match, NOW);
    const geojson = exportListGeoJson(list, [{ place, notes: [] }]);
    const repo = new DexieRepository(`phase3-geojson-osm-${crypto.randomUUID()}`);
    const providers = deps(match);

    try {
      const report = await runImport(
        repo,
        { name: "lisbon.geojson", bytes: strToU8(geojson) },
        providers,
        NOW,
      );

      expect(providers.resolver.resolveExact).toHaveBeenCalledWith(match.osmRef);
      expect(report.linked).toBe(1);
      expect((await repo.listPlaces())[0]?.place.currentOsmRef).toEqual(match.osmRef);
    } finally {
      repo.db.close();
    }
  });

  it("carries ODbL attribution when Takeout-shaped CSV contains OSM-derived fields", () => {
    const csv = exportListCsv(list, [{ place: createOsmPlace("place-1", poi(), NOW), notes: [] }]);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });

    expect(parsed.meta.fields).toEqual(["Title", "Note", "URL", "Address", "Attribution"]);
    expect(parsed.data[0]?.Attribution).toContain("© OpenStreetMap contributors");
    expect(parsed.data[0]?.Attribution).toContain("ODbL");
  });
});
