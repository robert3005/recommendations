/** Provider singletons wired to configured endpoints. */
import type { PoiResolver, SearchProvider } from "@placemarks/domain";
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
