/**
 * Provider singletons wired to configured endpoints. One geocoder, two calls,
 * two endpoints (spec/src/data-sources.md §Geocoder): Photon-class or
 * Pelias-class search (selected by VITE_GEOCODER) and OSM API lookup behind a
 * single interface. Photon and the OSM API are development defaults;
 * production configuration fails closed at build time (vite.config.ts) for
 * search and lookup alike.
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import type { StyleSpecification } from "maplibre-gl";
import {
  GEOCODER_KIND,
  MAP_GLYPHS_URL,
  MAP_PMTILES_URL,
  MAP_SPRITE_URL,
  MAP_STYLE_URL,
  OSM_ATTRIBUTION,
  PELIAS_URL,
} from "../config";
import { PLATE_OVERLAY_FONT, plateStyle } from "../map/basemapStyle";
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

/**
 * The canvas consumes the typed style capability, never a raw URL constant:
 * our own plate style when a PMTiles archive is configured, else a hosted
 * style URL.
 */
let cachedStyle: string | StyleSpecification | undefined;

/** Built once: the canvas reconciles style changes by identity, so a fresh
 * object per render would re-apply the whole style every render. */
function basemapStyle(): string | StyleSpecification {
  if (cachedStyle === undefined) {
    cachedStyle = MAP_PMTILES_URL
      ? plateStyle({
          pmtilesUrl: new URL(MAP_PMTILES_URL, window.location.origin).href,
          glyphsUrl: MAP_GLYPHS_URL,
          spriteUrl: new URL(MAP_SPRITE_URL, window.location.origin).href,
          // The canvas's own linked OSM credit is always shown beside this, so
          // the source credits only the tile schema — no doubled OSM line.
          attribution: '<a href="https://protomaps.com">Protomaps</a>',
        })
      : MAP_STYLE_URL;
  }
  return cachedStyle;
}

export const mapStyleProvider = {
  style: (): {
    style: string | StyleSpecification;
    overlayFont: string | undefined;
    attribution: string;
  } => ({
    style: basemapStyle(),
    // The plate's glyph server holds one font per folder (no combined stacks).
    overlayFont: MAP_PMTILES_URL ? PLATE_OVERLAY_FONT : undefined,
    attribution: OSM_ATTRIBUTION,
  }),
};
