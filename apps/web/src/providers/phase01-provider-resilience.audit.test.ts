/**
 * Provider-boundary behavior required from Phase 0: local result budgets,
 * transient retry, request coalescing, and negative caching. These are adapter
 * guarantees, so callers do not have to recreate provider policy.
 */
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../mocks/server";
import { OverpassProvider } from "./overpass";
import { PhotonSearchProvider } from "./photon";

function photonFeature(index: number) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-0.12 + index / 10_000, 51.5] },
    properties: {
      osm_type: "N",
      osm_id: index + 1,
      osm_key: "amenity",
      osm_value: "cafe",
      name: `Café ${index + 1}`,
    },
  };
}

const BBOX = { west: -0.13, south: 51.49, east: -0.11, north: 51.51 };

describe("Phase 0/1 provider resilience", () => {
  it("enforces the caller's search-result budget when upstream ignores its limit", async () => {
    const baseUrl = "https://phase01-search-budget.test";
    server.use(
      http.get(`${baseUrl}/api`, () =>
        HttpResponse.json({
          features: Array.from({ length: 5 }, (_, index) => photonFeature(index)),
        }),
      ),
    );

    const results = await new PhotonSearchProvider(baseUrl).search("cafe", { limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("retries a transient provider response and stops once the retry succeeds", async () => {
    const baseUrl = "https://phase01-search-retry.test";
    let requests = 0;
    server.use(
      http.get(`${baseUrl}/api`, () => {
        requests += 1;
        return requests === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ features: [photonFeature(0)] });
      }),
    );

    await expect(new PhotonSearchProvider(baseUrl).search("cafe")).resolves.toHaveLength(1);
    expect(requests).toBe(2);
  });

  it("coalesces concurrent identical viewport requests", async () => {
    const baseUrl = "https://phase01-coalescing.test/interpreter";
    let requests = 0;
    server.use(
      http.post(baseUrl, async () => {
        requests += 1;
        await delay(25);
        return HttpResponse.json({ elements: [] });
      }),
    );
    const provider = new OverpassProvider(baseUrl);

    await Promise.all([provider.discover(BBOX), provider.discover(BBOX)]);

    expect(requests).toBe(1);
  });

  it("negative-caches an identical empty viewport response", async () => {
    const baseUrl = "https://phase01-negative-cache.test/interpreter";
    let requests = 0;
    server.use(
      http.post(baseUrl, () => {
        requests += 1;
        return HttpResponse.json({ elements: [] });
      }),
    );
    const provider = new OverpassProvider(baseUrl);

    await provider.discover(BBOX);
    await provider.discover(BBOX);

    expect(requests).toBe(1);
  });
});
