/** Google external-ref identity and handoff take precedence over generic web provenance. */
import type { PoiResolver, SearchProvider } from "@placemarks/domain";
import { strToU8 } from "fflate";
import Papa from "papaparse";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportListCsv } from "./export";
import { runImport } from "./importer";

const NOW = "2026-07-19T12:00:00.000Z";
const GOOGLE_URL = "https://www.google.com/maps/place/Cafe/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";

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

describe("Phase 3 Google external-ref priority", () => {
  it("deduplicates by a Google id even when a generic web ref is listed first", async () => {
    const repo = new DexieRepository(`phase3-secondary-google-ref-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "list", name: "portable", createdAt: NOW, updatedAt: NOW });
      const existing = await repo.addToList(
        "list",
        {
          kind: "import",
          facts: { name: "Original café", lat: 38.7139, lng: -9.1394 },
          externalRef: { provider: "google-maps", url: GOOGLE_URL, importedAt: NOW },
        },
        NOW,
      );
      const geoJson = JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-8.61, 41.15] },
            properties: {
              name: "Renamed café",
              externalUrls: ["https://cafe.example/menu", GOOGLE_URL],
            },
          },
        ],
      });

      const report = await runImport(
        repo,
        { name: "portable.geojson", bytes: strToU8(geoJson) },
        noMatches(),
        NOW,
      );

      expect(report).toMatchObject({ placed: 0, duplicates: 1, review: 0 });
      expect((await repo.listPlaces()).map(({ place }) => place.id)).toEqual([existing.place.id]);
    } finally {
      repo.db.close();
    }
  });

  it("puts the retained Google listing in CSV's URL column before a generic web ref", async () => {
    const repo = new DexieRepository(`phase3-csv-google-ref-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "list", name: "portable", createdAt: NOW, updatedAt: NOW });
      const created = await repo.addToList(
        "list",
        {
          kind: "import",
          facts: { name: "Café", lat: 38.7139, lng: -9.1394 },
          externalRef: {
            provider: "web",
            url: "https://cafe.example/menu",
            importedAt: NOW,
          },
        },
        NOW,
      );
      const place = {
        ...created.place,
        externalRefs: [
          ...(created.place.externalRefs ?? []),
          { provider: "google-maps" as const, url: GOOGLE_URL, importedAt: NOW },
        ],
      };
      await repo.updatePlace(place);
      const list = await repo.getList("list");
      if (!list) throw new Error("list disappeared");

      const csv = exportListCsv(list, [{ place, notes: [] }]);
      const row = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      }).data[0];

      expect(row?.URL).toBe(GOOGLE_URL);
    } finally {
      repo.db.close();
    }
  });
});
