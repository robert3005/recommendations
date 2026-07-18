import { HttpResponse, http } from "msw";
import { OSM_API_URL, OVERPASS_URL, PHOTON_URL } from "../config";
import {
  osmNode101,
  osmNode102,
  osmNode599,
  osmWay201Full,
  overpassDiscover,
  overpassMigradoRecovery,
  overpassNearby,
  photonCafeResponse,
  photonMigradoResponse,
} from "./fixtures";

/**
 * node/599 is stateful: it resolves normally until a test flips the deletion
 * switch via the control endpoint below — simulating the upstream element being
 * deleted and redrawn as way/777. State is per page load, isolating tests.
 */
let node599Gone = false;

export const handlers = [
  http.get(`${PHOTON_URL}/api`, ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    if (q.toLowerCase().includes("migrado")) return HttpResponse.json(photonMigradoResponse);
    if (q.toLowerCase().includes("caf")) return HttpResponse.json(photonCafeResponse);
    return HttpResponse.json({ type: "FeatureCollection", features: [] });
  }),

  http.get(`${OSM_API_URL}/api/0.6/node/101.json`, () => HttpResponse.json(osmNode101)),
  http.get(`${OSM_API_URL}/api/0.6/node/102.json`, () => HttpResponse.json(osmNode102)),
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
  http.get(`${OSM_API_URL}/api/0.6/node/599.json`, () => {
    if (node599Gone) return HttpResponse.text("Gone", { status: 410 });
    return HttpResponse.json(osmNode599);
  }),
  // Test-only control: simulate the upstream deletion of node/599.
  http.post(`${OSM_API_URL}/__test/delete-node-599`, () => {
    node599Gone = true;
    return HttpResponse.json({ ok: true });
  }),

  http.post(OVERPASS_URL, async ({ request }) => {
    const query = new URLSearchParams(await request.text()).get("data") ?? "";
    if (query.includes("around")) {
      // (0, 0) is the fixture coordinate for "nothing mapped here".
      if (/around:\d+,0,0/.test(query)) return HttpResponse.json({ elements: [] });
      // Recovery search near the vanished node/599.
      if (/around:\d+,38\.72,-9\.16\b/.test(query)) {
        return HttpResponse.json(overpassMigradoRecovery);
      }
      return HttpResponse.json(overpassNearby);
    }
    return HttpResponse.json(overpassDiscover);
  }),
];
