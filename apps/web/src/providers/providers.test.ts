/**
 * Geocoder adapter tests against MSW fixtures (spec/src/data-sources.md
 * §Geocoder). Stadia v2 search: slim suggestions without coordinates, the
 * full record for a picked gid, full results for the import ladder — an
 * osmRef only when the result is sourced from OSM, other sources treated like
 * manual coordinates. OSM API lookup normalizes an element to a candidate.
 */
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  stadiaCafePlaces,
  stadiaCollection,
  stadiaFoursquarePlace,
  stadiaSuggestion,
} from "../mocks/fixtures";
import { server } from "../mocks/server";
import { OsmApiGeocoder } from "./osmApi";
import { StadiaGeocoder } from "./stadia";
import { wikipediaSummary } from "./wikipedia";

const STADIA_TEST_URL = "https://stadia.test";

/** Serve one v2 endpoint at the test base, recording the request URLs. */
function serve(endpoint: string, features: unknown[], seen: URL[] = []): URL[] {
  server.use(
    http.get(`${STADIA_TEST_URL}/v2/${endpoint}`, ({ request }) => {
      seen.push(new URL(request.url));
      return HttpResponse.json(stadiaCollection(features));
    }),
  );
  return seen;
}

describe("StadiaGeocoder.suggest", () => {
  it("reads slim autocomplete rows — no coordinates — taking the osmRef from the gid", async () => {
    serve("autocomplete", [
      stadiaSuggestion(stadiaFoursquarePlace),
      ...stadiaCafePlaces.map(stadiaSuggestion),
      { type: "Feature", geometry: null, properties: { gid: "x:y:z" } }, // nameless
      { type: "Feature", geometry: null, properties: { name: "No handle" } }, // no gid
    ]);
    const results = await new StadiaGeocoder(STADIA_TEST_URL, undefined).suggest("caf");
    expect(results).toEqual([
      {
        id: "foursquare:venue:652285383d92070f5588d28b",
        name: "Colonna & Small’s",
        where: "London, England",
      },
      {
        id: "openstreetmap:venue:node/101",
        name: "Café Central",
        where: "Lisboa, Portugal",
        osmRef: { type: "node", id: "101" },
      },
      {
        id: "openstreetmap:venue:way/201",
        name: "Café do Rio",
        where: "Lisboa, Portugal",
        osmRef: { type: "way", id: "201" },
      },
    ]);
  });

  it("sends text, size, layers, focus bias and api_key as query params — never a header", async () => {
    let authorization: string | null = "unset";
    const seen: URL[] = [];
    server.use(
      http.get(`${STADIA_TEST_URL}/v2/autocomplete`, ({ request }) => {
        seen.push(new URL(request.url));
        authorization = request.headers.get("authorization");
        return HttpResponse.json(stadiaCollection([]));
      }),
    );
    await new StadiaGeocoder(STADIA_TEST_URL, "k-123").suggest(
      "cafe",
      { lat: 38.7, lng: -9.1 },
      { limit: 3 },
    );
    const params = seen[0]?.searchParams;
    expect(params?.get("text")).toBe("cafe");
    expect(params?.get("size")).toBe("3");
    expect(params?.get("layers")).toBe("poi,address,street,locality");
    expect(params?.get("focus.point.lat")).toBe("38.7");
    expect(params?.get("focus.point.lon")).toBe("-9.1");
    expect(params?.get("api_key")).toBe("k-123");
    expect(authorization).toBeNull();

    await new StadiaGeocoder(STADIA_TEST_URL, undefined).suggest("cafe");
    expect(seen[1]?.searchParams.has("api_key")).toBe(false);
    expect(seen[1]?.searchParams.has("focus.point.lat")).toBe(false);
  });

  it("enforces the caller's result budget when the upstream ignores its size", async () => {
    serve("autocomplete", stadiaCafePlaces.map(stadiaSuggestion));
    const results = await new StadiaGeocoder(STADIA_TEST_URL, undefined).suggest("caf", undefined, {
      limit: 1,
    });
    expect(results).toHaveLength(1);
  });

  it("forwards the caller's AbortSignal to fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    serve("autocomplete", []);
    const controller = new AbortController();
    await new StadiaGeocoder(STADIA_TEST_URL, undefined).suggest("cafe", undefined, {
      signal: controller.signal,
    });
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    fetchSpy.mockRestore();
  });

  it("retries a transient upstream failure once, then gives up", async () => {
    let calls = 0;
    server.use(
      http.get(`${STADIA_TEST_URL}/v2/autocomplete`, () => {
        calls++;
        return calls === 1
          ? HttpResponse.text("busy", { status: 503 })
          : HttpResponse.json(stadiaCollection(stadiaCafePlaces.map(stadiaSuggestion)));
      }),
    );
    const geocoder = new StadiaGeocoder(STADIA_TEST_URL, undefined);
    expect(await geocoder.suggest("caf")).toHaveLength(2);
    expect(calls).toBe(2);

    server.use(
      http.get(`${STADIA_TEST_URL}/v2/autocomplete`, () =>
        HttpResponse.text("no", { status: 401 }),
      ),
    );
    await expect(geocoder.suggest("caf")).rejects.toThrow("stadia 401");
  });
});

describe("StadiaGeocoder.resolve", () => {
  it("fetches the picked gid's full record: position, address, and its OSM source", async () => {
    const seen = serve("place_details", [stadiaCafePlaces[0]]);
    const candidate = await new StadiaGeocoder(STADIA_TEST_URL, undefined).resolve(
      "openstreetmap:venue:node/101",
    );
    expect(seen[0]?.searchParams.get("ids")).toBe("openstreetmap:venue:node/101");
    expect(candidate).toEqual({
      name: "Café Central",
      lat: 38.7139,
      lng: -9.1394,
      address: "12 Rua Example, Lisboa 1100-000",
      osmRef: { type: "node", id: "101" },
    });
  });

  it("keeps a Foursquare venue without an osmRef, its coarse location as the address", async () => {
    serve("place_details", [stadiaFoursquarePlace]);
    const candidate = await new StadiaGeocoder(STADIA_TEST_URL, undefined).resolve(
      "foursquare:venue:652285383d92070f5588d28b",
    );
    expect(candidate).toEqual({
      name: "Colonna & Small’s",
      lat: 51.521636,
      lng: -0.110035,
      address: "London, England",
    });
  });

  it("answers undefined when the gid no longer resolves", async () => {
    serve("place_details", []);
    expect(
      await new StadiaGeocoder(STADIA_TEST_URL, undefined).resolve("openstreetmap:venue:node/1"),
    ).toBeUndefined();
  });
});

describe("StadiaGeocoder.search", () => {
  it("asks for venues first and widens to every place layer only on a miss", async () => {
    const layers: (string | null)[] = [];
    server.use(
      http.get(`${STADIA_TEST_URL}/v2/search`, ({ request }) => {
        const asked = new URL(request.url).searchParams.get("layers");
        layers.push(asked);
        return HttpResponse.json(stadiaCollection(asked === "poi" ? [] : [stadiaCafePlaces[1]]));
      }),
    );
    const geocoder = new StadiaGeocoder(STADIA_TEST_URL, undefined);
    expect((await geocoder.search("Rua Example 12")).map((r) => r.name)).toEqual(["Café do Rio"]);
    expect(layers).toEqual(["poi", "poi,address,street,locality"]);
  });

  it("strips a venue's own name from its formatted address line", async () => {
    serve("search", [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-0.10952, 51.51995] },
        properties: {
          gid: "openstreetmap:venue:node/4185611903",
          name: "Prufrock Coffee",
          coarse_location: "London, England",
          formatted_address_line: "Prufrock Coffee, London, United Kingdom",
        },
      },
    ]);
    const [result] = await new StadiaGeocoder(STADIA_TEST_URL, undefined).search("Prufrock");
    expect(result?.address).toBe("London, United Kingdom");
    expect(result?.osmRef).toEqual({ type: "node", id: "4185611903" });
  });

  it("returns full candidates in one call, dropping features without a position", async () => {
    const seen = serve("search", [
      ...stadiaCafePlaces,
      stadiaSuggestion(stadiaFoursquarePlace), // geometry: null
    ]);
    const results = await new StadiaGeocoder(STADIA_TEST_URL, undefined).search("cafe, Lisboa", {
      lat: 38.7,
      lng: -9.1,
    });
    expect(seen[0]?.searchParams.get("text")).toBe("cafe, Lisboa");
    expect(results.map((r) => r.name)).toEqual(["Café Central", "Café do Rio"]);
    // No street: the coarse location stands in for the address.
    expect(results[1]).toEqual({
      name: "Café do Rio",
      lat: 38.7107,
      lng: -9.1421,
      address: "Lisboa, Portugal",
      osmRef: { type: "way", id: "201" },
    });
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
