import { describe, expect, it } from "vitest";
import {
  allRefKeys,
  createManualPlace,
  createOsmPlace,
  displayFacts,
  isResolutionExpired,
  linkPlaceToOsm,
} from "./place";
import type { ResolvedPoi } from "./poi";
import { applyExactOutcome, applyRecovery, markStale, plausiblySameElement } from "./resolution";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-19T12:00:00.000Z";

function poi(overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "1" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    website: "https://cafecentral.pt/",
    identityTags: { name: "Café Central", amenity: "cafe", website: "https://cafecentral.pt/" },
    resolvedAt: NOW,
    ...overrides,
  };
}

describe("place creation", () => {
  it("an OSM place starts resolved with firstSeen == lastVerified", () => {
    const place = createOsmPlace("p1", poi(), NOW);
    expect(place.origin).toBe("osm");
    expect(place.resolutionState).toBe("resolved");
    expect(place.firstSeen).toEqual(place.lastVerified);
    expect(place.currentOsmRef).toEqual({ type: "node", id: "1" });
  });

  it("a manual place starts unlinked with owner facts and no OSM claim", () => {
    const place = createManualPlace("p2", { name: "Picnic bench", lat: 38.7, lng: -9.1 }, NOW);
    expect(place.origin).toBe("manual");
    expect(place.resolutionState).toBe("unlinked");
    expect(place.currentOsmRef).toBeUndefined();
    expect(displayFacts(place)).toMatchObject({ name: "Picnic bench", source: "manual" });
  });

  it("linking a manual place sets firstSeen once and enters the normal lifecycle", () => {
    const manual = createManualPlace(
      "p3",
      { name: "Café Central", lat: 38.7139, lng: -9.1394 },
      NOW,
    );
    const linked = linkPlaceToOsm(manual, poi(), LATER, "owner-confirmed");
    expect(linked.resolutionState).toBe("resolved");
    expect(linked.origin).toBe("manual"); // origin is provenance and never changes
    expect(linked.firstSeen?.observedAt).toBe(NOW);
    expect(linked.osmRefHistory).toHaveLength(0); // no previous binding, no interval
  });
});

describe("applyExactOutcome", () => {
  const base = createOsmPlace("p1", poi(), NOW);

  it("ok + plausible → resolved, lastVerified updated, identity unchanged", () => {
    const updatedPoi = poi({ website: "https://new-site.pt/", resolvedAt: LATER });
    const result = applyExactOutcome(base, { type: "ok", poi: updatedPoi }, LATER);
    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.place.resolutionState).toBe("resolved");
      expect(result.place.lastVerified?.website).toBe("https://new-site.pt/");
      expect(result.place.firstSeen?.website).toBe("https://cafecentral.pt/"); // immutable
    }
  });

  it("ok + radical move + incompatible identity → needs-review, never silent", () => {
    const repurposed = poi({
      name: "Auto Parts Warehouse",
      category: "car_parts",
      lat: 38.9, // ~20 km away
      website: undefined,
      identityTags: { name: "Auto Parts Warehouse", shop: "car_parts" },
      resolvedAt: LATER,
    });
    const result = applyExactOutcome(base, { type: "ok", poi: repurposed }, LATER);
    if (result.kind === "updated") {
      expect(result.place.resolutionState).toBe("needs-review");
      expect(result.place.lastVerified?.name).toBe("Café Central"); // not overwritten
    } else {
      throw new Error("expected updated");
    }
  });

  it("provider error → unavailable; binding retained; never evidence of disappearance", () => {
    const result = applyExactOutcome(base, { type: "error" }, LATER);
    if (result.kind === "updated") {
      expect(result.place.resolutionState).toBe("unavailable");
      expect(result.place.currentOsmRef).toEqual(base.currentOsmRef);
    } else {
      throw new Error("expected updated");
    }
  });

  it("gone → recovery is requested, not concluded", () => {
    const result = applyExactOutcome(base, { type: "gone" }, LATER);
    expect(result.kind).toBe("recover");
  });

  it("unlinked manual places are never resolved", () => {
    const manual = createManualPlace("m", { name: "Bench", lat: 1, lng: 1 }, NOW);
    const result = applyExactOutcome(manual, { type: "error" }, LATER);
    if (result.kind === "updated") expect(result.place.resolutionState).toBe("unlinked");
  });
});

describe("applyRecovery", () => {
  const base = createOsmPlace("p1", poi(), NOW);

  it("unique high-confidence replacement → automatic relink with immutable history", () => {
    const replacement = poi({ osmRef: { type: "way", id: "42" }, resolvedAt: LATER });
    const recovered = applyRecovery(base, [replacement], LATER);
    expect(recovered.resolutionState).toBe("resolved");
    expect(recovered.currentOsmRef).toEqual({ type: "way", id: "42" });
    expect(recovered.osmRefHistory).toHaveLength(1);
    const interval = recovered.osmRefHistory[0];
    expect(interval?.ref).toEqual({ type: "node", id: "1" });
    expect(interval?.linkedAt).toBe(NOW);
    expect(interval?.unlinkedAt).toBe(LATER);
    expect(interval?.reason).toBe("resolver-match");
    expect(allRefKeys(recovered).sort()).toEqual(["node/1", "way/42"]);
  });

  it("ambiguous candidates → needs-review", () => {
    const a = poi({ osmRef: { type: "way", id: "42" }, resolvedAt: LATER });
    const b = poi({ osmRef: { type: "way", id: "43" }, resolvedAt: LATER });
    expect(applyRecovery(base, [a, b], LATER).resolutionState).toBe("needs-review");
  });

  it("no plausible candidate → missing, lastVerified kept for display", () => {
    const recovered = applyRecovery(base, [], LATER);
    expect(recovered.resolutionState).toBe("missing");
    expect(recovered.lastVerified?.name).toBe("Café Central");
  });
});

describe("staleness", () => {
  it("TTL expiry marks stale without touching identity", () => {
    const place = createOsmPlace("p1", poi(), NOW);
    expect(isResolutionExpired(place, "2026-07-20T00:00:00.000Z")).toBe(false);
    expect(isResolutionExpired(place, "2026-08-01T00:00:00.000Z")).toBe(true);
    const stale = markStale(place, "2026-08-01T00:00:00.000Z");
    expect(stale.resolutionState).toBe("stale");
    expect(stale.currentOsmRef).toEqual(place.currentOsmRef);
  });
});

describe("plausiblySameElement", () => {
  const prev = createOsmPlace("p1", poi(), NOW).lastVerified;

  it("accepts ordinary field changes in place", () => {
    if (!prev) throw new Error("no evidence");
    expect(plausiblySameElement(prev, poi({ website: "https://other.pt/" }))).toBe(true);
  });
  it("accepts a rename at the same location", () => {
    if (!prev) throw new Error("no evidence");
    expect(
      plausiblySameElement(
        prev,
        poi({ name: "New Owner Café", identityTags: { name: "New Owner Café" } }),
      ),
    ).toBe(true);
  });
  it("rejects a radical move with incompatible identity", () => {
    if (!prev) throw new Error("no evidence");
    expect(
      plausiblySameElement(
        prev,
        poi({
          name: "Warehouse",
          category: "warehouse",
          lat: 39.5,
          identityTags: { name: "Warehouse" },
        }),
      ),
    ).toBe(false);
  });
});
