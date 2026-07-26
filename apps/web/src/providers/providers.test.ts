/**
 * Geocoder adapter tests against MSW fixtures (spec/src/data-sources.md
 * §Geocoder): search and lookup both normalize to domain GeocoderCandidate,
 * and every result records its osmRef — geocoder results are OSM data.
 */
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../mocks/server";
import { OsmApiGeocoder } from "./osmApi";
import { PhotonGeocoder } from "./photon";

describe("PhotonGeocoder.search", () => {
  it("normalizes features to candidates recording osmRef, dropping ref-less ones", async () => {
    const results = await new PhotonGeocoder().search("cafe");
    expect(results).toHaveLength(2); // the third fixture has no osm_id
    expect(results[0]).toMatchObject({
      name: "Café Central",
      address: "Rua Example 12, Lisboa 1100-000",
      osmRef: { type: "node", id: "101" },
    });
    expect(results[1]?.osmRef).toEqual({ type: "way", id: "201" });
  });

  it("enforces the caller's result budget when the upstream ignores its limit", async () => {
    const baseUrl = "https://search-budget.test";
    server.use(
      http.get(`${baseUrl}/api`, () =>
        HttpResponse.json({
          features: Array.from({ length: 5 }, (_, index) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [-0.12 + index / 10_000, 51.5] },
            properties: { osm_type: "N", osm_id: index + 1, name: `Café ${index + 1}` },
          })),
        }),
      ),
    );

    const results = await new PhotonGeocoder(baseUrl).search("cafe", undefined, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("retries a transient upstream failure once — adapter policy, not caller policy", async () => {
    const baseUrl = "https://search-retry.test";
    let requests = 0;
    server.use(
      http.get(`${baseUrl}/api`, () => {
        requests += 1;
        return requests === 1
          ? HttpResponse.text("upstream unavailable", { status: 503 })
          : HttpResponse.json({
              features: [
                {
                  type: "Feature",
                  geometry: { type: "Point", coordinates: [-0.12, 51.5] },
                  properties: { osm_type: "N", osm_id: 7, name: "Café Retry" },
                },
              ],
            });
      }),
    );

    const results = await new PhotonGeocoder(baseUrl).search("cafe");
    expect(requests).toBe(2);
    expect(results[0]?.name).toBe("Café Retry");
  });
});

describe("OsmApiGeocoder.lookup", () => {
  const geocoder = new OsmApiGeocoder();

  it("resolves a node to a candidate with assembled address and its ref", async () => {
    const candidate = await geocoder.lookup({ type: "node", id: "101" });
    expect(candidate).toMatchObject({
      name: "Café Central",
      osmRef: { type: "node", id: "101" },
    });
    expect(candidate?.address).toContain("Rua Example 12");
  });

  it("computes a representative point for ways from member nodes", async () => {
    const candidate = await geocoder.lookup({ type: "way", id: "201" });
    expect(candidate?.lat).toBeCloseTo(38.7107, 3);
    expect(candidate?.lng).toBeCloseTo(-9.1421, 3);
    expect(candidate?.name).toBe("Café do Rio");
  });

  it("maps 404 and 410 to undefined — the only definitive disappearance signals", async () => {
    expect(await geocoder.lookup({ type: "node", id: "404" })).toBeUndefined();
    expect(await geocoder.lookup({ type: "node", id: "410" })).toBeUndefined();
  });

  it("throws on server failure — unavailability is not disappearance", async () => {
    await expect(geocoder.lookup({ type: "node", id: "500" })).rejects.toThrow(/osm api 500/);
  });

  it("throws when a successful response is missing the requested element", async () => {
    const baseUrl = "https://lookup-malformed.test";
    server.use(
      http.get(`${baseUrl}/api/0.6/node/42.json`, () =>
        HttpResponse.json({ version: "0.6", elements: [] }),
      ),
    );
    await expect(new OsmApiGeocoder(baseUrl).lookup({ type: "node", id: "42" })).rejects.toThrow(
      /element missing/,
    );
  });
});
