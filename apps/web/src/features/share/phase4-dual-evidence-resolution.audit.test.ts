/** Conservative public recovery must use both evidence epochs as one decision. */
import type { PoiResolver, ResolvedPoi } from "@placemarks/domain";
import type { SharedPlaceAnchor, SharedPlaceEvidence } from "@placemarks/schemas";
import { describe, expect, it, vi } from "vitest";
import { resolveSharedAnchor } from "./resolveShared";

const NOW = "2026-07-19T12:00:00.000Z";

function evidence(
  refId: string,
  name: string,
  lat: number,
  lng: number,
  stableIds: Record<string, string>,
): SharedPlaceEvidence {
  return {
    osmRef: { type: "node", id: refId },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name,
    category: "cafe",
    lat,
    lng,
    stableIds,
    observedAt: NOW,
  };
}

function poi(
  type: "node" | "way" | "relation",
  id: string,
  name: string,
  lat: number,
  lng: number,
  identityTags: Record<string, string>,
): ResolvedPoi {
  return {
    osmRef: { type, id },
    name,
    category: "cafe",
    lat,
    lng,
    identityTags,
    resolvedAt: NOW,
  };
}

describe("Phase 4 first-seen plus last-verified recovery", () => {
  it("searches near both copied evidence coordinates", async () => {
    const firstSeen = evidence("101", "Original cafe", 38.7139, -9.1394, {
      wikidata: "Q-ORIGINAL",
    });
    const lastVerified = evidence("101", "Later copied name", 40.0, -7.0, {});
    const replacement = poi("way", "202", "Original cafe", 38.714, -9.1395, {
      wikidata: "Q-ORIGINAL",
    });
    const searchNearby = vi.fn(async ({ lat }: { lat: number }) =>
      Math.abs(lat - firstSeen.lat) < 0.001 ? [replacement] : [],
    );
    const resolver: PoiResolver = {
      resolveExact: async () => ({ type: "gone" }),
      searchNearby,
      discover: async () => ({ pois: [], truncated: false }),
    };
    const anchor: SharedPlaceAnchor = {
      kind: "osm",
      currentOsmRef: { type: "node", id: "101" },
      firstSeen,
      lastVerified,
    };

    const result = await resolveSharedAnchor(resolver, anchor);
    // The first epoch supports this replacement, but the distant, renamed
    // last-verified epoch does not. Searching both locations is necessary but
    // not sufficient: both epochs must converge before relinking.
    expect(result.state).not.toBe("recovered");
    expect(searchNearby).toHaveBeenCalledWith(
      expect.objectContaining({ lat: firstSeen.lat, lng: firstSeen.lng }),
    );
    expect(searchNearby).toHaveBeenCalledWith(
      expect.objectContaining({ lat: lastVerified.lat, lng: lastVerified.lng }),
    );
  });

  it("requires one unique winner across both evidence epochs", async () => {
    const firstSeen = evidence("101", "Original cafe", 38.7139, -9.1394, {
      wikidata: "Q-FIRST",
    });
    const lastVerified = evidence("101", "Renamed cafe", 38.7139, -9.1394, {
      wikidata: "Q-LAST",
    });
    const firstCandidate = poi("way", "201", "Original cafe", 38.7139, -9.1394, {
      wikidata: "Q-FIRST",
    });
    const lastCandidate = poi("relation", "202", "Renamed cafe", 38.7139, -9.1394, {
      wikidata: "Q-LAST",
    });
    const resolver: PoiResolver = {
      resolveExact: async () => ({ type: "gone" }),
      searchNearby: async () => [firstCandidate, lastCandidate],
      discover: async () => ({ pois: [], truncated: false }),
    };
    const anchor: SharedPlaceAnchor = {
      kind: "osm",
      currentOsmRef: { type: "node", id: "101" },
      firstSeen,
      lastVerified,
    };

    await expect(resolveSharedAnchor(resolver, anchor)).resolves.toMatchObject({
      state: "ambiguous",
    });
  });
});
