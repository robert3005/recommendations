import { markerAt, type PoiResolver, type ResolvedPoi } from "@placemarks/domain";
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { saveSharedGuide } from "./saveSharedGuide";

const NOW = "2026-07-19T12:00:00.000Z";
const poi: ResolvedPoi = {
  osmRef: { type: "node", id: "101" },
  osmVersion: 7,
  name: "Already local café",
  category: "cafe",
  lat: 38.7139,
  lng: -9.1394,
  identityTags: {},
  resolvedAt: NOW,
};

describe("Phase 4 offline shared-guide import deduplication", () => {
  it("reuses an exact local OSM match when the live resolver is unavailable", async () => {
    const repo = new DexieRepository(`phase4-local-match-${crypto.randomUUID()}`);
    const resolver: PoiResolver = {
      resolveExact: async () => ({ type: "error" }),
      searchNearby: async () => [],
      discover: async () => ({ pois: [], truncated: false }),
    };
    const evidence = {
      osmRef: poi.osmRef,
      osmVersion: poi.osmVersion,
      source: "OpenStreetMap" as const,
      license: "ODbL-1.0" as const,
      attribution: "© OpenStreetMap contributors" as const,
      name: poi.name,
      category: poi.category,
      lat: poi.lat,
      lng: poi.lng,
      observedAt: poi.resolvedAt,
    };
    const guide: SharedGuide = {
      v: 1,
      title: "Shared exact match",
      blocks: [
        {
          id: "place-1",
          type: "place",
          place: {
            kind: "osm",
            currentOsmRef: poi.osmRef,
            firstSeen: evidence,
            lastVerified: evidence,
          },
        },
      ],
      contentHash: "hash",
    };

    try {
      await repo.createList({
        id: "existing",
        name: "Existing",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const local = await repo.addToList("existing", { kind: "poi", poi }, NOW);

      const result = await saveSharedGuide(repo, resolver, guide, NOW);

      expect(result).toMatchObject({ added: 1, pending: 0 });
      expect(await repo.listPlaces()).toHaveLength(1);
      expect(await repo.listIdsForPlace(local.place.id)).toContain(result.listId);
    } finally {
      repo.db.close();
    }
  });
});
