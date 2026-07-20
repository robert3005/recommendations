/** Conservative geocoding and attribution continuity are Phase 3 import invariants. */
import {
  createOsmPlace,
  type List,
  markerAt,
  type PoiResolver,
  type ResolvedPoi,
  type SearchProvider,
  type SearchResult,
} from "@placemarks/domain";
import { strToU8 } from "fflate";
import Papa from "papaparse";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportListCsv } from "./export";
import { resolveReviewItem, runImport } from "./importer";

const NOW = "2026-07-19T12:00:00.000Z";

function providers(options: {
  searchResults?: SearchResult[];
  exact?: Awaited<ReturnType<PoiResolver["resolveExact"]>>;
  poi?: ResolvedPoi;
}): { search: SearchProvider; resolver: PoiResolver } {
  return {
    search: { search: vi.fn(async () => options.searchResults ?? []) },
    resolver: {
      resolveExact: vi.fn(
        async () =>
          options.exact ??
          (options.poi ? { type: "ok" as const, poi: options.poi } : { type: "gone" as const }),
      ),
      searchNearby: vi.fn(async () => []),
      discover: vi.fn(async () => ({ pois: [], truncated: false })),
    },
  };
}

describe("Phase 3 conservative geocoding", () => {
  it("does not auto-link a category-contradicting candidate with the same name and address", async () => {
    const repo = new DexieRepository(`phase3-category-contradiction-${crypto.randomUUID()}`);
    const candidate: SearchResult = {
      ref: { type: "node", id: "101" },
      name: "Central",
      category: "school",
      address: "10 Example Road, Lisbon",
      lat: 38.7139,
      lng: -9.1394,
    };
    const resolved: ResolvedPoi = {
      osmRef: candidate.ref,
      name: candidate.name,
      category: "school",
      address: candidate.address,
      lat: candidate.lat,
      lng: candidate.lng,
      identityTags: { amenity: "school", name: candidate.name },
      resolvedAt: NOW,
    };
    const geoJson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [] },
          properties: {
            name: "Central",
            category: "cafe",
            address: "10 Example Road, Lisbon",
          },
        },
      ],
    });

    try {
      const report = await runImport(
        repo,
        { name: "category.geojson", bytes: strToU8(geoJson) },
        providers({ searchResults: [candidate], poi: resolved }),
        NOW,
      );

      expect(report).toMatchObject({ placed: 0, linked: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 ODbL attribution continuity", () => {
  it("keeps CSV's OSM provenance after an unresolved anchor is placed manually from review", async () => {
    const sourceList: List = {
      id: "source-list",
      name: "OSM source",
      marker: markerAt(0),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const poi: ResolvedPoi = {
      osmRef: { type: "node", id: "202" },
      name: "OSM café",
      category: "cafe",
      address: "20 Open Road, Lisbon",
      lat: 38.72,
      lng: -9.14,
      identityTags: { amenity: "cafe", name: "OSM café" },
      resolvedAt: NOW,
    };
    const csv = exportListCsv(sourceList, [
      { place: createOsmPlace("source-place", poi, NOW), notes: [] },
    ]);
    const repo = new DexieRepository(`phase3-attribution-roundtrip-${crypto.randomUUID()}`);
    const deps = providers({ exact: { type: "gone" } });

    try {
      const report = await runImport(
        repo,
        { name: "osm-source.csv", bytes: strToU8(csv) },
        deps,
        NOW,
      );
      expect(report.review).toBe(1);
      const review = await repo.db.importItems.where("batchId").equals(report.batchId).first();
      if (!review) throw new Error("review row was not persisted");

      await resolveReviewItem(
        repo,
        deps,
        review.id,
        { kind: "coords", lat: poi.lat, lng: poi.lng },
        NOW,
      );

      const importedList = (await repo.listLists())[0];
      const importedPlace = (await repo.listPlaces())[0]?.place;
      if (!importedList || !importedPlace) throw new Error("manual review did not materialize");
      const reExported = exportListCsv(importedList, [{ place: importedPlace, notes: [] }]);
      const row = Papa.parse<Record<string, string>>(reExported, {
        header: true,
        skipEmptyLines: true,
      }).data[0];

      expect(row?.Attribution).toContain("© OpenStreetMap contributors");
      expect(row?.Attribution).toContain("ODbL");
    } finally {
      repo.db.close();
    }
  });
});
