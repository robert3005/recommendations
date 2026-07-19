/** Offline local dedup follows the same two-epoch recovery rule as the viewer. */
import type { PoiResolver } from "@placemarks/domain";
import type { SharedGuide, SharedPlaceEvidence } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { saveSharedGuide } from "./saveSharedGuide";

const NOW = "2026-07-19T13:00:00.000Z";

function evidence(
  name: string,
  lat: number,
  lng: number,
  stableIds?: Record<string, string>,
): SharedPlaceEvidence {
  return {
    osmRef: { type: "node", id: "101" },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name,
    category: "cafe",
    lat,
    lng,
    ...(stableIds ? { stableIds } : {}),
    observedAt: NOW,
  };
}

const unavailable: PoiResolver = {
  resolveExact: async () => ({ type: "error" }),
  searchNearby: async () => [],
  discover: async () => ({ pois: [], truncated: false }),
};

describe("Phase 4 offline two-epoch evidence deduplication", () => {
  it("keeps the shared place pending when only one evidence epoch matches locally", async () => {
    const repo = new DexieRepository(`phase4-local-two-epoch-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "existing", name: "Existing", createdAt: NOW, updatedAt: NOW });
      await repo.addToList(
        "existing",
        {
          kind: "poi",
          poi: {
            osmRef: { type: "way", id: "202" },
            name: "Original café",
            category: "cafe",
            lat: 38.7139,
            lng: -9.1394,
            identityTags: { wikidata: "Q-FIRST" },
            resolvedAt: NOW,
          },
        },
        NOW,
      );
      const guide: SharedGuide = {
        v: 1,
        title: "Imported guide",
        blocks: [
          {
            id: "cafe-block",
            type: "place",
            place: {
              kind: "osm",
              currentOsmRef: { type: "node", id: "101" },
              firstSeen: evidence("Original café", 38.7139, -9.1394, {
                wikidata: "Q-FIRST",
              }),
              lastVerified: evidence("Different later place", 40, -7),
            },
          },
        ],
        contentHash: "fixture",
      };

      const result = await saveSharedGuide(repo, unavailable, guide, NOW);

      expect(result).toMatchObject({ added: 0, pending: 1 });
      expect(
        await repo.listIdsForPlace((await repo.listPlaces())[0]?.place.id ?? "missing"),
      ).toEqual(["existing"]);
    } finally {
      repo.db.close();
    }
  });
});
