/**
 * The basemap style capability, kept apart from the geocoder singletons in
 * ./index.ts: it pulls in MapLibre, PMTiles and the Protomaps layers, so only
 * the lazily loaded map canvas may import it — the notebook shell must paint
 * without waiting for the map stack.
 */
import type { StyleSpecification } from "maplibre-gl";
import {
  MAP_GLYPHS_URL,
  MAP_PMTILES_URL,
  MAP_SPRITE_URL,
  MAP_STYLE_URL,
  OSM_ATTRIBUTION,
} from "../config";
import { PLATE_OVERLAY_FONT, type PlateScheme, plateLayers, plateStyle } from "../map/basemapStyle";

/**
 * The canvas consumes the typed style capability, never a raw URL constant:
 * our own plate style when a PMTiles archive is configured, else a hosted
 * style URL. The plate follows the chrome theme; a hosted style has one look,
 * so its scene stays the light plate's.
 */
let cachedStyle: string | StyleSpecification | undefined;
const cachedPlateLayers = new Map<PlateScheme, StyleSpecification["layers"]>();

/** Built once, in the theme at first paint: the canvas reconciles style
 * changes by identity, so a fresh object per render would reload the style.
 * Later theme changes repaint the plate's layers instead (`basemapLayers`). */
function basemapStyle(scheme: PlateScheme): string | StyleSpecification {
  if (cachedStyle === undefined) {
    cachedStyle = MAP_PMTILES_URL
      ? plateStyle({
          pmtilesUrl: new URL(MAP_PMTILES_URL, window.location.origin).href,
          glyphsUrl: MAP_GLYPHS_URL,
          spriteUrl: new URL(MAP_SPRITE_URL, window.location.origin).href,
          // The canvas's own linked OSM credit is always shown beside this, so
          // the source credits only the tile schema — no doubled OSM line.
          attribution: '<a href="https://protomaps.com">Protomaps</a>',
          scheme,
        })
      : MAP_STYLE_URL;
  }
  return cachedStyle;
}

function basemapLayers(scheme: PlateScheme): StyleSpecification["layers"] | undefined {
  if (!MAP_PMTILES_URL) return undefined;
  let layers = cachedPlateLayers.get(scheme);
  if (!layers) {
    layers = plateLayers(scheme);
    cachedPlateLayers.set(scheme, layers);
  }
  return layers;
}

export const mapStyleProvider = {
  style: (
    theme: PlateScheme = "paper",
  ): {
    style: string | StyleSpecification;
    /** The theme the map scene is actually painted in. */
    scheme: PlateScheme;
    basemapLayers: StyleSpecification["layers"] | undefined;
    overlayFont: string | undefined;
    attribution: string;
  } => {
    const scheme: PlateScheme = MAP_PMTILES_URL ? theme : "paper";
    return {
      style: basemapStyle(scheme),
      scheme,
      basemapLayers: basemapLayers(scheme),
      // The plate's glyph server holds one font per folder (no combined stacks).
      overlayFont: MAP_PMTILES_URL ? PLATE_OVERLAY_FONT : undefined,
      attribution: OSM_ATTRIBUTION,
    };
  },
};
