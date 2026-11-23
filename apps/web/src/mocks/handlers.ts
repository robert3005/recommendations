import { createShareApp, MemoryStorage, type StoredDocument } from "@placemarks/share-service";
import { HttpResponse, http } from "msw";
import { OSM_API_URL, STADIA_URL } from "../config";
import { sampleProfile } from "../features/insights/sample";
import {
  MOCK_INSIGHTS_ACCESS_KEY,
  osmNode101,
  osmNode102,
  osmNode599,
  osmWay201Full,
  SHORT_LINK_FIXTURE,
  type StadiaPlaceFixture,
  stadiaCafePlaces,
  stadiaCollection,
  stadiaFoursquarePlace,
  stadiaMigradoPlaces,
  stadiaSuggestion,
  wikipediaSummaryCafeCentral,
} from "./fixtures";

/**
 * The dev/e2e share service is the REAL service app over in-memory storage —
 * same protocol (PUT 201/200/403/410, GET with ETag, DELETE 204), same limits,
 * zero network (spec/src/sharing.md §The share service). In the browser the
 * documents round-trip through localStorage so published pages survive full
 * page reloads within a session.
 */
const SHARE_STATE_KEY = "placemarks:msw-share-state";

class PersistentMemoryStorage extends MemoryStorage {
  constructor() {
    super();
    try {
      const raw = globalThis.localStorage?.getItem(SHARE_STATE_KEY);
      if (raw) {
        for (const doc of JSON.parse(raw) as StoredDocument[]) void super.create(doc);
      }
    } catch {
      // Fresh state when storage is unavailable or corrupt.
    }
  }

  private persist(): void {
    try {
      const { docs } = this as unknown as { docs: Map<string, StoredDocument> };
      globalThis.localStorage?.setItem(SHARE_STATE_KEY, JSON.stringify([...docs.values()]));
    } catch {
      // Best effort only — the mock service still works in-memory.
    }
  }

  override async create(doc: StoredDocument): Promise<boolean> {
    const created = await super.create(doc);
    this.persist();
    return created;
  }

  override async update(...args: Parameters<MemoryStorage["update"]>): Promise<boolean> {
    const updated = await super.update(...args);
    this.persist();
    return updated;
  }

  override async revoke(...args: Parameters<MemoryStorage["revoke"]>): Promise<void> {
    await super.revoke(...args);
    this.persist();
  }
}

/**
 * Short-link expansion against the real route with a canned upstream: the
 * fixture share link redirects to its Google Maps place URL; anything else
 * answers without a redirect, which the route reports as unresolved.
 */
const shareApp = createShareApp({
  storage: new PersistentMemoryStorage(),
  fetchUpstream: async (url) =>
    url === SHORT_LINK_FIXTURE.short
      ? new Response(null, { status: 302, headers: { location: SHORT_LINK_FIXTURE.expanded } })
      : new Response("", { status: 200 }),
  // Hosted review insights with sample data in place of SerpApi and the model.
  insights: {
    accessKey: MOCK_INSIGHTS_ACCESS_KEY,
    fetchPlace: async (request) => ({
      place: {
        name: request.name ?? "Sample place",
        rating: 4.4,
        ratingCount: 1289,
        priceLevel: 1,
      },
      reviews: [{ id: "rev_sample", text: "Sample review.", contentHash: "sample" }],
      photos: [1, 2, 3, 4, 5].map((n) => ({
        id: `pho_sample_${n}`,
        url: `/sample-insights/photo-${n}.jpg`,
        attribution: { name: "Sample photo" },
        source: "sample",
      })),
    }),
    classify: async (place) => sampleProfile(place.sourcePlaceKey, new Date().toISOString()),
  },
});

const STADIA_PLACES: StadiaPlaceFixture[] = [
  ...stadiaCafePlaces,
  ...stadiaMigradoPlaces,
  stadiaFoursquarePlace,
];

/** The mock's whole matching rule: which fixture places a typed text finds. */
function stadiaMatches(text: string): StadiaPlaceFixture[] {
  const q = text.toLowerCase();
  if (q.includes("migrado")) return stadiaMigradoPlaces;
  if (q.includes("caf")) return stadiaCafePlaces;
  if (q.includes("colonna")) return [stadiaFoursquarePlace];
  return [];
}

export const handlers = [
  // The whole /s surface — reads, mutations, and CORS preflights.
  http.all(/\/s\/(lists|posts)(\/.*)?$/, ({ request }) => shareApp.fetch(request.clone())),
  http.all(/\/s\/resolve-link(\?.*)?$/, ({ request }) => shareApp.fetch(request.clone())),
  http.all(/\/i\/places$/, ({ request }) => shareApp.fetch(request.clone())),
  // The sync surface of the same service (spec/src/sync.md §The service). The
  // mock keeps a library in memory only, which is all one browser needs.
  http.all(/\/y\/[0-9a-f]{32}(\/.*)?$/, ({ request }) => shareApp.fetch(request.clone())),

  // Place search (Stadia v2): slim suggestions while typing, the full record
  // for a picked gid, and full results for the import ladder — one fixture
  // world behind all three.
  http.get(`${STADIA_URL}/v2/autocomplete`, ({ request }) => {
    const text = new URL(request.url).searchParams.get("text") ?? "";
    return HttpResponse.json(stadiaCollection(stadiaMatches(text).map(stadiaSuggestion)));
  }),
  http.get(`${STADIA_URL}/v2/place_details`, ({ request }) => {
    const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",");
    return HttpResponse.json(
      stadiaCollection(STADIA_PLACES.filter((place) => ids.includes(place.properties.gid))),
    );
  }),
  http.get(`${STADIA_URL}/v2/search`, ({ request }) => {
    const text = new URL(request.url).searchParams.get("text") ?? "";
    return HttpResponse.json(stadiaCollection(stadiaMatches(text)));
  }),

  // Geocoder lookup (OSM element API), including the error-path fixtures.
  http.get(`${OSM_API_URL}/api/0.6/node/101.json`, () => HttpResponse.json(osmNode101)),
  http.get(`${OSM_API_URL}/api/0.6/node/102.json`, () => HttpResponse.json(osmNode102)),
  http.get(`${OSM_API_URL}/api/0.6/node/599.json`, () => HttpResponse.json(osmNode599)),
  http.get(`${OSM_API_URL}/api/0.6/node/404.json`, () =>
    HttpResponse.text("Not Found", { status: 404 }),
  ),
  http.get(`${OSM_API_URL}/api/0.6/node/410.json`, () =>
    HttpResponse.text("Gone", { status: 410 }),
  ),
  http.get(`${OSM_API_URL}/api/0.6/node/500.json`, () =>
    HttpResponse.text("Server Error", { status: 500 }),
  ),
  http.get(`${OSM_API_URL}/api/0.6/way/201/full.json`, () => HttpResponse.json(osmWay201Full)),

  // Wikipedia REST summary for osmNode101's wikipedia tag; any other pt title
  // is a missing article — 404 is the endpoint's "no such page" answer.
  http.get("https://pt.wikipedia.org/api/rest_v1/page/summary/:title", ({ params }) =>
    decodeURIComponent(String(params.title)) === "Café Central (Lisboa)"
      ? HttpResponse.json(wikipediaSummaryCafeCentral)
      : HttpResponse.json({ type: "not_found" }, { status: 404 }),
  ),
];
