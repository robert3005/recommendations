/**
 * Provider singletons wired to configured endpoints. One geocoder, two calls,
 * two endpoints (spec/src/data-sources.md §Geocoder): Photon-class or
 * Pelias-class search (selected by VITE_GEOCODER) and OSM API lookup behind a
 * single interface. Photon and the OSM API are development defaults;
 * production configuration fails closed at build time (vite.config.ts) for
 * search and lookup alike.
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import { GEOCODER_KIND, PELIAS_URL } from "../config";
import { OsmApiGeocoder } from "./osmApi";
import { PeliasGeocoder } from "./pelias";
import { PhotonGeocoder } from "./photon";

export interface Geocoder {
  search(text: string, bias?: { lat: number; lng: number }): Promise<GeocoderCandidate[]>;
  lookup(ref: OsmRef): Promise<GeocoderCandidate | undefined>;
}

function searchProvider(): PeliasGeocoder | PhotonGeocoder {
  if (GEOCODER_KIND === "pelias") {
    // Pelias has no keyless public demo, so there is no default to fall back to.
    if (!PELIAS_URL) {
      throw new Error(
        "VITE_GEOCODER=pelias requires VITE_PELIAS_URL (spec/src/data-sources.md §Geocoder) — " +
          "point it at Stadia Maps, Geoapify, geocode.earth, or a self-hosted Pelias.",
      );
    }
    return new PeliasGeocoder(PELIAS_URL);
  }
  return new PhotonGeocoder();
}

const search = searchProvider();
const osmApi = new OsmApiGeocoder();

export const geocoder: Geocoder = {
  search: (text, bias) => search.search(text, bias),
  lookup: (ref) => osmApi.lookup(ref),
};
