/** Place-creation policy (spec/src/place-identity.md). */
import { describe, expect, it } from "vitest";
import * as placeModule from "./place";

describe("place creation policy", () => {
  it("OSM-backed places begin with a resolved element and evidence", () => {
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
    expect(place.pastOsmRefs).toHaveLength(0);
    expect(place.manual?.name).toBe("Picnic bench");
  });

  it("origin is provenance: linking a manual place keeps origin and sets firstSeen once", () => {
    const manual = placeModule.createManualPlace(
      "p-manual",
      { name: "Café Escondido", lat: 38.7, lng: -9.1 },
      "2026-07-18T00:00:00.000Z",
    );
    const linked = placeModule.linkPlaceToOsm(
      manual,
      {
        osmRef: { type: "node", id: "7" },
        name: "Café Escondido",
        category: "cafe",
        lat: 38.7001,
        lng: -9.1001,
        identityTags: { name: "Café Escondido", amenity: "cafe" },
        resolvedAt: "2026-07-19T00:00:00.000Z",
      },
      "2026-07-19T00:00:00.000Z",
      "owner-confirmed",
    );
    expect(linked.origin).toBe("manual");
    expect(linked.resolutionState).toBe("resolved");
    expect(linked.firstSeen?.ref).toEqual({ type: "node", id: "7" });
    expect(linked.manual?.name).toBe("Café Escondido"); // retained as provenance
  });
});
