/**
 * Geocoder adapter tests against MSW fixtures (spec/src/data-sources.md
 * §Geocoder): search and lookup normalize to domain GeocoderCandidate.
 * Photon results always record an osmRef; Pelias-class results record one
 * only when sourced from OSM — other open sources yield candidates without
 * one, treated like manual coordinates.
 */
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { PELIAS_TEST_URL } from "../mocks/fixtures";
import { server } from "../mocks/server";
import { OsmApiGeocoder } from "./osmApi";
import { PeliasGeocoder } from "./pelias";
import { PhotonGeocoder } from "./photon";
import { wikipediaSummary } from "./wikipedia";

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

describe("PhotonGeocoder back-off", () => {
  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-0.12, 51.5] },
    properties: { osm_type: "N", osm_id: 9, name: "Café Patient" },
  };

  it("stands off and retries once after a rate limit", async () => {
    const baseUrl = "https://photon-429.test";
    let requests = 0;
    server.use(
      http.get(`${baseUrl}/api`, () => {
        requests += 1;
        return requests === 1
          ? HttpResponse.text("slow down", { status: 429 })
          : HttpResponse.json({ features: [feature] });
      }),
    );
    const results = await new PhotonGeocoder(baseUrl, 0).search("cafe");
    expect(requests).toBe(2);
    expect(results[0]?.name).toBe("Café Patient");
  });

  it("retries once when the network drops the request — a browser's view of a bare rate limit", async () => {
    const baseUrl = "https://photon-drop.test";
    let requests = 0;
    server.use(
      http.get(`${baseUrl}/api`, () => {
        requests += 1;
        return requests === 1 ? HttpResponse.error() : HttpResponse.json({ features: [feature] });
      }),
    );
    const results = await new PhotonGeocoder(baseUrl, 0).search("cafe");
    expect(requests).toBe(2);
    expect(results).toHaveLength(1);
  });

  it("gives up after the one retry", async () => {
    const baseUrl = "https://photon-down.test";
    server.use(http.get(`${baseUrl}/api`, () => HttpResponse.text("no", { status: 429 })));
    await expect(new PhotonGeocoder(baseUrl, 0).search("cafe")).rejects.toThrow("photon 429");
  });
});

describe("PeliasGeocoder.search", () => {
  it("records osmRef only for openstreetmap-sourced features, filtering nameless ones", async () => {
    const results = await new PeliasGeocoder(PELIAS_TEST_URL, undefined).search("cafe");
    expect(results).toHaveLength(4); // the fifth fixture has neither name nor label
    expect(results[0]).toMatchObject({
      name: "Café Pelias",
      address: "12 Rua Example, Lisboa 1100-000",
      osmRef: { type: "node", id: "301" },
    });
    expect(results[1]?.osmRef).toEqual({ type: "way", id: "401" });
    // Label minus name when the structured address fields are absent.
    expect(results[1]?.address).toBe("Lisboa, Portugal");
    // Open sources that are not OSM — candidates without an osmRef, treated
    // like manual coordinates: no ODbL claim, no OSM deep link.
    expect(results[2]).toMatchObject({ name: "14 Rua Aberta" });
    expect(results[2]?.osmRef).toBeUndefined();
    expect(results[3]?.osmRef).toBeUndefined();
  });

  it("sends text, size, layers, focus bias, and api_key as query params — never a header", async () => {
    const baseUrl = "https://pelias-params.test";
    let captured: URL | undefined;
    let authorization: string | null = null;
    server.use(
      http.get(`${baseUrl}/v1/autocomplete`, ({ request }) => {
        captured = new URL(request.url);
        authorization = request.headers.get("authorization");
        return HttpResponse.json({ type: "FeatureCollection", features: [] });
      }),
    );

    await new PeliasGeocoder(baseUrl, "test-key").search(
      "cafe",
      { lat: 38.7139, lng: -9.1394 },
      { limit: 5 },
    );

    expect(captured?.searchParams.get("text")).toBe("cafe");
    expect(captured?.searchParams.get("size")).toBe("5");
    expect(captured?.searchParams.get("layers")).toBe("venue,address,street,locality");
    expect(captured?.searchParams.get("focus.point.lat")).toBe("38.7139");
    expect(captured?.searchParams.get("focus.point.lon")).toBe("-9.1394");
    expect(captured?.searchParams.get("api_key")).toBe("test-key");
    expect(authorization).toBeNull();
  });

  it("enforces the caller's result budget when the upstream ignores its limit", async () => {
    const results = await new PeliasGeocoder(PELIAS_TEST_URL, undefined).search("cafe", undefined, {
      limit: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("forwards the caller's AbortSignal to fetch", async () => {
    // The MSW/jsdom pairing never rejects an aborted mocked request, so the
    // abortability contract is asserted at the fetch boundary instead.
    const controller = new AbortController();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ type: "FeatureCollection", features: [] })));
    try {
      await new PeliasGeocoder("https://pelias-abort.test", undefined).search("cafe", undefined, {
        signal: controller.signal,
      });
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    } finally {
      fetchSpy.mockRestore();
    }
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

  it("maps a wikimedia_commons File: tag to a Special:FilePath thumbnail URL", async () => {
    const candidate = await geocoder.lookup({ type: "node", id: "101" });
    expect(candidate?.imageUrl).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Caf%C3%A9%20Central%20(Lisboa).jpg?width=640",
    );
    // A tagless element yields no imageUrl at all.
    expect(await geocoder.lookup({ type: "node", id: "102" })).not.toHaveProperty("imageUrl");
  });

  it("accepts an image tag only when it is https and Wikimedia-hosted", async () => {
    const baseUrl = "https://lookup-image.test";
    const node = (id: number, tags: Record<string, string>) => ({
      version: "0.6",
      elements: [{ type: "node", id, lat: 38.7, lon: -9.1, tags: { name: "X", ...tags } }],
    });
    server.use(
      http.get(`${baseUrl}/api/0.6/node/1.json`, () =>
        HttpResponse.json(
          node(1, { image: "https://upload.wikimedia.org/wikipedia/commons/1/2a/X.jpg" }),
        ),
      ),
      http.get(`${baseUrl}/api/0.6/node/2.json`, () =>
        HttpResponse.json(node(2, { image: "https://example.com/photo.jpg" })),
      ),
      http.get(`${baseUrl}/api/0.6/node/3.json`, () =>
        HttpResponse.json(node(3, { image: "http://commons.wikimedia.org/wiki/X.jpg" })),
      ),
    );
    const lookups = new OsmApiGeocoder(baseUrl);
    expect((await lookups.lookup({ type: "node", id: "1" }))?.imageUrl).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/1/2a/X.jpg",
    );
    expect(await lookups.lookup({ type: "node", id: "2" })).not.toHaveProperty("imageUrl");
    expect(await lookups.lookup({ type: "node", id: "3" })).not.toHaveProperty("imageUrl");
  });

  it("maps the richer POI tags onto the candidate, wikipedia kept as the raw tag", async () => {
    const candidate = await geocoder.lookup({ type: "node", id: "101" });
    expect(candidate).toMatchObject({
      website: "https://cafecentral.pt",
      phone: "+351 21 000 0000",
      openingHours: "Mo-Fr 08:00-18:00; Sa 09:00-14:00",
      cuisine: "portuguese",
      wheelchair: "limited",
      description: "Historic café on Rua Example, pouring bica since 1923.",
      wikipedia: "pt:Café Central (Lisboa)",
    });
    // The sparse element yields none of them.
    const sparse = await geocoder.lookup({ type: "node", id: "102" });
    for (const key of [
      "website",
      "phone",
      "openingHours",
      "cuisine",
      "wheelchair",
      "description",
      "wikipedia",
    ]) {
      expect(sparse).not.toHaveProperty(key);
    }
  });

  it("takes website from website|contact:website|url, https only; phone falls back to contact:phone", async () => {
    const baseUrl = "https://lookup-facts.test";
    const node = (id: number, tags: Record<string, string>) => ({
      version: "0.6",
      elements: [{ type: "node", id, lat: 38.7, lon: -9.1, tags: { name: "X", ...tags } }],
    });
    server.use(
      // An http website is dropped, and the https contact:website steps in.
      http.get(`${baseUrl}/api/0.6/node/1.json`, () =>
        HttpResponse.json(
          node(1, { website: "http://insecure.example", "contact:website": "https://x.example" }),
        ),
      ),
      http.get(`${baseUrl}/api/0.6/node/2.json`, () =>
        HttpResponse.json(node(2, { url: "https://url-tag.example" })),
      ),
      http.get(`${baseUrl}/api/0.6/node/3.json`, () =>
        HttpResponse.json(node(3, { website: "no-scheme.example" })),
      ),
      http.get(`${baseUrl}/api/0.6/node/4.json`, () =>
        HttpResponse.json(node(4, { "contact:phone": "+351 21 111 1111" })),
      ),
    );
    const lookups = new OsmApiGeocoder(baseUrl);
    expect((await lookups.lookup({ type: "node", id: "1" }))?.website).toBe("https://x.example");
    expect((await lookups.lookup({ type: "node", id: "2" }))?.website).toBe(
      "https://url-tag.example",
    );
    expect(await lookups.lookup({ type: "node", id: "3" })).not.toHaveProperty("website");
    expect((await lookups.lookup({ type: "node", id: "4" }))?.phone).toBe("+351 21 111 1111");
  });

  it("keeps wheelchair only for yes|limited|no", async () => {
    const baseUrl = "https://lookup-wheelchair.test";
    const node = (id: number, wheelchair: string) => ({
      version: "0.6",
      elements: [{ type: "node", id, lat: 38.7, lon: -9.1, tags: { name: "X", wheelchair } }],
    });
    server.use(
      http.get(`${baseUrl}/api/0.6/node/1.json`, () => HttpResponse.json(node(1, "yes"))),
      http.get(`${baseUrl}/api/0.6/node/2.json`, () => HttpResponse.json(node(2, "designated"))),
    );
    const lookups = new OsmApiGeocoder(baseUrl);
    expect((await lookups.lookup({ type: "node", id: "1" }))?.wheelchair).toBe("yes");
    expect(await lookups.lookup({ type: "node", id: "2" })).not.toHaveProperty("wheelchair");
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

describe("wikipediaSummary", () => {
  it("resolves a lang-prefixed tag against that language wiki and parses the summary", async () => {
    const summary = await wikipediaSummary("pt:Café Central (Lisboa)");
    expect(summary).toEqual({
      extract: expect.stringContaining("café histórico de Lisboa"),
      thumbnailUrl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Cafe_Central_Lisboa.jpg/320px-Cafe_Central_Lisboa.jpg",
      articleUrl: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)",
    });
  });

  it("defaults to the English wiki when the tag carries no lang prefix", async () => {
    let requested: string | undefined;
    server.use(
      http.get("https://en.wikipedia.org/api/rest_v1/page/summary/:title", ({ request }) => {
        requested = request.url;
        return HttpResponse.json({ extract: "An article." });
      }),
    );
    const summary = await wikipediaSummary("Jerónimos Monastery");
    expect(requested).toBe(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent("Jerónimos Monastery")}`,
    );
    expect(summary?.extract).toBe("An article.");
  });

  it("rejects a thumbnail whose host is not Wikimedia", async () => {
    server.use(
      http.get("https://en.wikipedia.org/api/rest_v1/page/summary/:title", () =>
        HttpResponse.json({
          extract: "An article.",
          thumbnail: { source: "https://example.com/hotlinked.jpg" },
        }),
      ),
    );
    const summary = await wikipediaSummary("Somewhere");
    expect(summary).not.toHaveProperty("thumbnailUrl");
    expect(summary?.extract).toBe("An article.");
  });

  it("truncates the extract to 600 characters at capture", async () => {
    server.use(
      http.get("https://en.wikipedia.org/api/rest_v1/page/summary/:title", () =>
        HttpResponse.json({ extract: "x".repeat(700) }),
      ),
    );
    const summary = await wikipediaSummary("Long Article");
    expect(summary?.extract).toHaveLength(600);
  });

  it("answers undefined for a missing article — 404 is not an error", async () => {
    expect(await wikipediaSummary("pt:Página Inexistente")).toBeUndefined();
  });
});
