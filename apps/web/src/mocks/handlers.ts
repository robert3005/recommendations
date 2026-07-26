import { createShareApp, MemoryStorage, type StoredDocument } from "@placemarks/share-service";
import { HttpResponse, http } from "msw";
import { OSM_API_URL, PHOTON_URL } from "../config";
import {
  osmNode101,
  osmNode102,
  osmNode599,
  osmWay201Full,
  photonCafeResponse,
  photonMigradoResponse,
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

const shareApp = createShareApp({ storage: new PersistentMemoryStorage() });

export const handlers = [
  // The whole /s surface — reads, mutations, and CORS preflights.
  http.all(/\/s\/(lists|posts)(\/.*)?$/, ({ request }) => shareApp.fetch(request.clone())),

  // Geocoder search (Photon). Fixtures shared with providers and importer tests.
  http.get(`${PHOTON_URL}/api`, ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    if (q.toLowerCase().includes("migrado")) return HttpResponse.json(photonMigradoResponse);
    if (q.toLowerCase().includes("caf")) return HttpResponse.json(photonCafeResponse);
    return HttpResponse.json({ type: "FeatureCollection", features: [] });
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
];
