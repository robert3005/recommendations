/** Provider singletons wired to configured endpoints. */
import type { MapStyleProvider, PoiResolver, SearchProvider } from "@placemarks/domain";
import { MAP_STYLE_URL } from "../config";
import { OsmApiResolver } from "./osmApi";
import { OverpassProvider } from "./overpass";
import { PhotonSearchProvider } from "./photon";

const osmApi = new OsmApiResolver();
const overpass = new OverpassProvider();

export const searchProvider: SearchProvider = new PhotonSearchProvider();

export const poiResolver: PoiResolver = {
  resolveExact: (ref, opts) => osmApi.resolveExact(ref, opts),
  searchNearby: (params) => overpass.searchNearby(params),
  discover: (bbox, opts) => overpass.discover(bbox, opts),
};

/** The canvas consumes the typed style capability, never a raw URL constant. */
export const mapStyleProvider: MapStyleProvider = {
  style: () => ({ styleUrl: MAP_STYLE_URL, attribution: "© OpenStreetMap contributors" }),
};
