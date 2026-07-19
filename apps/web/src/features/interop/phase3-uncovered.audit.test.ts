/**
 * Phase 3 contract gaps not exercised by the original operational/portability
 * audit suites. These are black-box round-trip and row-accounting checks.
 */
import type { PoiResolver, SearchProvider } from "@placemarks/domain";
import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportListGeoJson } from "./export";
import { runImport } from "./importer";
import { parseImportFile } from "./parse";

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

describe("Phase 3 uncovered KML source-list cases", () => {
  it("accounts for document-level placemarks when the same KML also has folders", async () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Mixed trip</name>
  <Placemark><name>Loose pin</name><Point><coordinates>-9.1,38.7</coordinates></Point></Placemark>
  <Folder><name>Food</name>
    <Placemark><name>Folder café</name><Point><coordinates>-9.2,38.8</coordinates></Point></Placemark>
  </Folder>
</Document></kml>`;

    const parsed = await parseImportFile({ name: "mixed.kml", bytes: strToU8(kml) });

    expect(parsed.lists.flatMap((entry) => entry.items.map((item) => item.title)).sort()).toEqual([
      "Folder café",
      "Loose pin",
    ]);
  });

  it("keeps identically named KML folders as distinct, deduplicated local lists", async () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Two days</name>
  <Folder><name>Food</name>
    <Placemark><name>Day one</name><Point><coordinates>-9.1,38.7</coordinates></Point></Placemark>
  </Folder>
  <Folder><name>Food</name>
    <Placemark><name>Day two</name><Point><coordinates>-8.6,41.1</coordinates></Point></Placemark>
  </Folder>
</Document></kml>`;
    const repo = new DexieRepository(`phase3-duplicate-folders-${crypto.randomUUID()}`);

    try {
      await runImport(repo, { name: "two-days.kml", bytes: strToU8(kml) }, noMatches(), NOW);

      const lists = await repo.listLists();
      expect(lists).toHaveLength(2);
      expect(new Set(lists.map((list) => list.name)).size).toBe(2);
    } finally {
      repo.db.close();
    }
  });

  it("retains the marker colour referenced through a standard KML StyleMap", async () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Style id="red-normal"><IconStyle><color>ff0000ff</color></IconStyle></Style>
  <StyleMap id="red-map"><Pair><key>normal</key><styleUrl>#red-normal</styleUrl></Pair></StyleMap>
  <Folder><name>Food</name>
    <Placemark><name>Café</name><styleUrl>#red-map</styleUrl><Point><coordinates>-9.1,38.7</coordinates></Point></Placemark>
  </Folder>
</Document></kml>`;

    const parsed = await parseImportFile({ name: "styled.kml", bytes: strToU8(kml) });

    expect(parsed.lists[0]?.color).toBe("#ff0000");
  });
});

describe("Phase 3 uncovered GeoJSON interchange cases", () => {
  it("preserves phone, hours, tags, notes, and every external URL across import and export", async () => {
    const externalUrls = [
      "https://www.google.com/maps/place/Example",
      "https://venue.example/menu",
    ];
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
          properties: {
            name: "Café Central",
            phone: "+351 210 000 000",
            openingHours: "Mo-Su 08:00-20:00",
            tags: ["Coffee", "Late"],
            note: "Keep this note",
            externalUrls,
          },
        },
      ],
    });
    const repo = new DexieRepository(`phase3-geojson-fidelity-${crypto.randomUUID()}`);

    try {
      const report = await runImport(
        repo,
        { name: "portable.geojson", bytes: strToU8(geojson) },
        noMatches(),
        NOW,
      );
      expect(report).toMatchObject({ placed: 1, review: 0 });

      const list = (await repo.listLists())[0];
      const view = (await repo.listPlaces())[0];
      if (!list || !view) throw new Error("GeoJSON import did not materialize its place and list");
      const notes = await repo.listNotesForPlace(view.place.id);
      const properties = (
        JSON.parse(exportListGeoJson(list, [{ ...view, notes }])) as {
          features: Array<{ properties: Record<string, unknown> }>;
        }
      ).features[0]?.properties;

      expect(properties).toMatchObject({
        phone: "+351 210 000 000",
        openingHours: "Mo-Su 08:00-20:00",
        tags: ["Coffee", "Late"],
        note: "Keep this note",
        externalUrls,
      });
    } finally {
      repo.db.close();
    }
  });
});
