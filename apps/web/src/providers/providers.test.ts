/** Provider adapter tests against MSW fixtures. */
import { describe, expect, it } from "vitest";
import { OsmApiResolver } from "./osmApi";
import { OverpassProvider } from "./overpass";
import { PhotonSearchProvider } from "./photon";

describe("PhotonSearchProvider", () => {
  it("normalizes features to typed OSM candidates and drops ref-less ones", async () => {
    const provider = new PhotonSearchProvider();
    const results = await provider.search("cafe");
    expect(results).toHaveLength(2); // the third fixture has no osm_id
    expect(results[0]).toMatchObject({
      ref: { type: "node", id: "101" },
      name: "Café Central",
      category: "cafe",
      address: "Rua Example 12, 1100-000 Lisboa",
    });
    expect(results[1]?.ref).toEqual({ type: "way", id: "201" });
  });
});

describe("OsmApiResolver", () => {
  const resolver = new OsmApiResolver(undefined, () => "2026-07-18T12:00:00.000Z");

  it("resolves a node with derived fields", async () => {
    const outcome = await resolver.resolveExact({ type: "node", id: "101" });
    expect(outcome.type).toBe("ok");
    if (outcome.type === "ok") {
      expect(outcome.poi.name).toBe("Café Central");
      expect(outcome.poi.website).toBe("https://cafecentral.pt/");
      expect(outcome.poi.osmVersion).toBe(5);
      expect(outcome.poi.address).toContain("Rua Example 12");
    }
  });

  it("computes a representative point for ways from member nodes", async () => {
    const outcome = await resolver.resolveExact({ type: "way", id: "201" });
    expect(outcome.type).toBe("ok");
    if (outcome.type === "ok") {
      expect(outcome.poi.lat).toBeCloseTo(38.7107, 3);
      expect(outcome.poi.lng).toBeCloseTo(-9.1421, 3);
      expect(outcome.poi.website).toBe("https://cafedorio.pt/");
    }
  });

  it("maps 404 and 410 to gone — the only definitive disappearance signals", async () => {
    expect((await resolver.resolveExact({ type: "node", id: "404" })).type).toBe("gone");
    expect((await resolver.resolveExact({ type: "node", id: "410" })).type).toBe("gone");
  });

  it("maps server failures to error, never gone", async () => {
    expect((await resolver.resolveExact({ type: "node", id: "500" })).type).toBe("error");
  });
});

describe("OverpassProvider", () => {
  const provider = new OverpassProvider(undefined, () => "2026-07-18T12:00:00.000Z");

  it("parses nearby candidates including way centers", async () => {
    const pois = await provider.searchNearby({ lat: 38.7139, lng: -9.1394, radiusM: 80 });
    expect(pois).toHaveLength(3);
    const way = pois.find((p) => p.osmRef.type === "way");
    expect(way?.lat).toBeCloseTo(38.7107, 3);
    expect(way?.name).toBe("Café do Rio");
  });

  it("refuses oversized viewport queries as truncated instead of querying", async () => {
    const result = await provider.discover({ west: -10, south: 38, east: -8, north: 40 });
    expect(result.pois).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it("discovers POIs within a small bbox", async () => {
    const result = await provider.discover({
      west: -9.145,
      south: 38.71,
      east: -9.135,
      north: 38.717,
    });
    expect(result.pois.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });
});
