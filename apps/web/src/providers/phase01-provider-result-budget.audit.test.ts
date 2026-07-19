/**
 * Authoritative provider budget from book/src/data-sources.md: viewport
 * discovery remains bounded even when an upstream ignores the requested cap.
 */
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../mocks/server";
import { OverpassProvider } from "./overpass";

describe("Phase 1 provider result budget", () => {
  it("enforces the requested discovery limit on the normalized result", async () => {
    const baseUrl = "https://phase01-budget.test/interpreter";
    server.use(
      http.post(baseUrl, () =>
        HttpResponse.json({
          // A provider or proxy can ignore the Overpass `out` cap. The adapter
          // is still the boundary responsible for the application's budget.
          elements: Array.from({ length: 5 }, (_, index) => ({
            type: "node",
            id: index + 1,
            lat: 51.5 + index / 10_000,
            lon: -0.12,
            tags: { name: `Place ${index + 1}`, amenity: "cafe" },
          })),
        }),
      ),
    );
    const provider = new OverpassProvider(baseUrl, () => "2026-07-19T12:00:00.000Z");

    const result = await provider.discover(
      { west: -0.13, south: 51.49, east: -0.11, north: 51.51 },
      { limit: 2 },
    );

    expect(result.truncated).toBe(true);
    expect(result.pois).toHaveLength(2);
  });
});
