import { describe, expect, it } from "vitest";
import * as placeModule from "./place";

/**
 * Place-creation policy per the ratified design (book/src/place-identity.md,
 * decided in the 2026-07-18 design review):
 *
 * - OSM-backed places begin with a successfully resolved OSM element.
 * - Unlinked manual pins ARE part of the durable model (user decision: "Restore
 *   manual pins" — vision.md, roadmap Phase 2), but they must start `unlinked`
 *   with owner-provided facts and may NEVER fabricate an OSM claim.
 *
 * Note: an earlier revision of this test asserted that `createManualPlace` must
 * not exist. That reflected a proposal the design review explicitly overruled;
 * the enforced policy below is the documented one.
 */
describe("place creation policy", () => {
  it("exposes a manual-place factory (user-ratified: manual pins are in scope)", () => {
    expect(placeModule).toHaveProperty("createManualPlace");
  });

  it("manual places start unlinked, with owner facts and no OSM claim", () => {
    const place = placeModule.createManualPlace(
      "p-manual",
      { name: "Picnic bench", lat: 38.7, lng: -9.1 },
      "2026-07-18T00:00:00.000Z",
    );
    expect(place.origin).toBe("manual");
    expect(place.resolutionState).toBe("unlinked");
    expect(place.currentOsmRef).toBeUndefined();
    expect(place.firstSeen).toBeUndefined();
    expect(place.lastVerified).toBeUndefined();
    expect(place.osmRefHistory).toHaveLength(0);
    expect(place.manual?.name).toBe("Picnic bench");
  });

  it("OSM-backed places always begin with a resolved element and evidence", () => {
    const poi = {
      osmRef: { type: "node" as const, id: "1" },
      category: "cafe",
      lat: 38.7,
      lng: -9.1,
      identityTags: {},
      resolvedAt: "2026-07-18T00:00:00.000Z",
    };
    const place = placeModule.createOsmPlace("p-osm", poi, "2026-07-18T00:00:00.000Z");
    expect(place.currentOsmRef).toEqual({ type: "node", id: "1" });
    expect(place.firstSeen).toBeDefined();
    expect(place.resolutionState).toBe("resolved");
  });
});
