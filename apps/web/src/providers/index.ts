/**
 * Provider singletons wired to configured endpoints. One geocoder behind a
 * single interface (spec/src/data-sources.md §Geocoder): place search on
 * Stadia Maps — slim suggestions while typing, the full record for the one
 * picked, full results for the import ladder — and exact OSM element lookup
 * on the OSM API. The OSM API default is a development endpoint; a
 * production build fails closed at build time (vite.config.ts) when pointed
 * at it.
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import { OsmApiGeocoder } from "./osmApi";
import { type PlaceSuggestion, StadiaGeocoder } from "./stadia";

export type { PlaceSuggestion } from "./stadia";

export interface Geocoder {
  /** Dropdown rows while typing: cheap, and without coordinates. */
  suggest(text: string, bias?: { lat: number; lng: number }): Promise<PlaceSuggestion[]>;
  /** The full record — position, address — behind a picked suggestion. */
  resolve(id: string): Promise<GeocoderCandidate | undefined>;
  /** Full results in one call, for the import ladder. */
  search(text: string, bias?: { lat: number; lng: number }): Promise<GeocoderCandidate[]>;
  lookup(ref: OsmRef): Promise<GeocoderCandidate | undefined>;
}

const stadia = new StadiaGeocoder();
const osmApi = new OsmApiGeocoder();

export const geocoder: Geocoder = {
  suggest: (text, bias) => stadia.suggest(text, bias),
  resolve: (id) => stadia.resolve(id),
  search: (text, bias) => stadia.search(text, bias),
  lookup: (ref) => osmApi.lookup(ref),
};
