import type { PoiResolver, ResolvedPoi } from "@placemarks/domain";
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { saveSharedGuide } from "./saveSharedGuide";

const NOW = "2026-07-19T12:00:00.000Z";
const poi: ResolvedPoi = {
  osmRef: { type: "node", id: "101" },
  osmVersion: 7,
  name: "Eventually resolved café",
  category: "cafe",
  lat: 38.7139,
  lng: -9.1394,
  identityTags: { wikidata: "Q101" },
  resolvedAt: NOW,
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
  stableIds: poi.identityTags,
  observedAt: poi.resolvedAt,
};
const guide: SharedGuide = {
  v: 1,
  kind: "list",
  title: "Eventually resolved guide",
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

describe("Phase 4 pending shared-guide convergence", () => {
  it("clears a pending preview when a later import resolves the same anchor", async () => {
    const repo = new DexieRepository(`phase4-pending-convergence-${crypto.randomUUID()}`);
    const unavailable: PoiResolver = {
      resolveExact: async () => ({ type: "error" }),
      searchNearby: async () => [],
      discover: async () => ({ pois: [], truncated: false }),
    };
    const available: PoiResolver = {
      resolveExact: async () => ({ type: "ok", poi }),
      searchNearby: async () => [],
      discover: async () => ({ pois: [], truncated: false }),
    };

    try {
      expect(await saveSharedGuide(repo, unavailable, guide, NOW)).toMatchObject({ pending: 1 });
      expect(await saveSharedGuide(repo, available, guide, NOW)).toMatchObject({ added: 1 });

      expect(await repo.db.importItems.filter((item) => item.status === "review").count()).toBe(0);
    } finally {
      repo.db.close();
    }
  });
});
