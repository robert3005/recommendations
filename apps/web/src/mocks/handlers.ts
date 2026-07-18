import { HttpResponse, http } from "msw";
import { OSM_API_URL, OVERPASS_URL, PHOTON_URL } from "../config";
import {
  osmNode101,
  osmNode102,
  osmWay201Full,
  overpassDiscover,
  overpassNearby,
  photonCafeResponse,
} from "./fixtures";

export const handlers = [
  http.get(`${PHOTON_URL}/api`, ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
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

  http.post(OVERPASS_URL, async ({ request }) => {
    const body = await request.text();
    if (body.includes("around")) return HttpResponse.json(overpassNearby);
    return HttpResponse.json(overpassDiscover);
  }),
];
