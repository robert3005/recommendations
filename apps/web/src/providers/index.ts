/**
 * Provider singletons wired to configured endpoints. One geocoder, two calls,
 * two endpoints (spec/src/data-sources.md §Geocoder): Photon-class search and
 * OSM API lookup behind a single interface. Both endpoints are development
 * defaults; production configuration fails closed at build time
 * (vite.config.ts) for search and lookup alike.
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import { MAP_STYLE_URL, OSM_ATTRIBUTION } from "../config";
import { OsmApiGeocoder } from "./osmApi";
import { PhotonGeocoder } from "./photon";

export interface Geocoder {
  search(text: string, bias?: { lat: number; lng: number }): Promise<GeocoderCandidate[]>;
  lookup(ref: OsmRef): Promise<GeocoderCandidate | undefined>;
}

const photon = new PhotonGeocoder();
const osmApi = new OsmApiGeocoder();

export const geocoder: Geocoder = {
  search: (text, bias) => photon.search(text, bias),
  lookup: (ref) => osmApi.lookup(ref),
};

/** The canvas consumes the typed style capability, never a raw URL constant. */
export const mapStyleProvider = {
  style: (): { styleUrl: string; attribution: string } => ({
    styleUrl: MAP_STYLE_URL,
    attribution: OSM_ATTRIBUTION,
  }),
};
