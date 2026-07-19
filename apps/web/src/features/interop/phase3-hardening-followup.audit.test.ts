/**
 * Follow-up black-box checks for the hardening decisions now recorded in
 * book/src/interop.md. These extend writer-to-parser checks through actual
 * repository materialization and exercise nested KML source-list styling.
 */
import {
  createOsmPlace,
  type List,
  type PoiResolver,
  type ResolvedPoi,
  type SearchProvider,
  withExternalRef,
} from "@placemarks/domain";
import { strToU8 } from "fflate";
import Papa from "papaparse";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportListCsv, exportListGeoJson } from "./export";
import { resolveReviewItem, runImport } from "./importer";
import { parseKml } from "./parse";

const NOW = "2026-07-19T12:00:00.000Z";

function noMatches(): { search: SearchProvider; resolver: PoiResolver } {
  return {
    search: { search: vi.fn(async () => []) },
    resolver: {
      resolveExact: vi.fn(async () => ({ type: "gone" as const })),
      searchNearby: vi.fn(async () => []),
      discover: vi.fn(async () => ({ pois: [], truncated: false })),
    },
  };
}

describe("Phase 3 GeoJSON materialization fidelity", () => {
  it("keeps website through import, local storage, and the next GeoJSON export", async () => {
    const repo = new DexieRepository(`phase3-website-materialization-${crypto.randomUUID()}`);
    const website = "https://cafe.example/menu";
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      name: "Portable trip",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
          properties: { name: "Café Central", category: "cafe", website },
        },
      ],
    });

    try {
      await runImport(
        repo,
        { name: "portable.geojson", bytes: strToU8(geojson) },
        noMatches(),
        NOW,
      );
      const list = (await repo.listLists())[0];
      const view = (await repo.listPlaces())[0];
      if (!list || !view) throw new Error("GeoJSON import did not materialize");
      const properties = (
        JSON.parse(
          exportListGeoJson(list, [
            { ...view, notes: await repo.listNotesForPlace(view.place.id) },
          ]),
        ) as { features: Array<{ properties: Record<string, unknown> }> }
      ).features[0]?.properties;

      expect(properties?.website).toBe(website);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 KML nested source-list styling", () => {
  it("uses a folder's direct placemark style rather than a nested folder's style", () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Style id="blue"><IconStyle><color>ffff0000</color></IconStyle></Style>
  <Style id="red"><IconStyle><color>ff0000ff</color></IconStyle></Style>
  <Folder><name>Outer day</name>
    <Folder><name>Inner day</name>
      <Placemark><name>Nested view</name><styleUrl>#blue</styleUrl>
        <Point><coordinates>-9.2,38.8</coordinates></Point>
      </Placemark>
    </Folder>
    <Placemark><name>Outer café</name><styleUrl>#red</styleUrl>
      <Point><coordinates>-9.1,38.7</coordinates></Point>
    </Placemark>
  </Folder>
</Document></kml>`;

    const lists = parseKml(kml, "fallback");

    expect(lists.find((list) => list.name === "Outer day")?.color).toBe("#ff0000");
    expect(lists.find((list) => list.name === "Inner day")?.color).toBe("#0000ff");
  });
});

describe("Phase 3 CSV ODbL continuity with retained Google identity", () => {
  it("keeps attribution after an OSM-derived row with a Google URL is manually placed", async () => {
    const repo = new DexieRepository(`phase3-google-osm-attribution-${crypto.randomUUID()}`);
    const sourceList: List = {
      id: "source-list",
      name: "Source",
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
    const googleUrl =
      "https://www.google.com/maps/place/OSM+Cafe/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";
    const sourcePlace = withExternalRef(
      createOsmPlace("source-place", poi, NOW),
      { provider: "google-maps", url: googleUrl, importedAt: NOW },
      NOW,
    );
    const csv = exportListCsv(sourceList, [{ place: sourcePlace, notes: [] }]);
    const deps = noMatches();

    try {
      const report = await runImport(repo, { name: "source.csv", bytes: strToU8(csv) }, deps, NOW);
      const review = await repo.db.importItems.where("batchId").equals(report.batchId).first();
      if (!review) throw new Error("unresolved CSV row was not retained for review");
      await resolveReviewItem(
        repo,
        deps,
        review.id,
        { kind: "coords", lat: poi.lat, lng: poi.lng },
        NOW,
      );

      const list = (await repo.listLists())[0];
      const place = (await repo.listPlaces())[0]?.place;
      if (!list || !place) throw new Error("manual placement did not materialize");
      const row = Papa.parse<Record<string, string>>(exportListCsv(list, [{ place, notes: [] }]), {
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
