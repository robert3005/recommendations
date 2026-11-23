/**
 * Provider endpoints. The defaults are public/demo services and are DEVELOPMENT-ONLY
 * per spec/src/data-sources.md — a production release must point these at contracted
 * or self-hosted deployments via VITE_* env configuration (the build fails closed).
 */
/**
 * Our tile service (services/tiles, a Cloudflare Worker over the R2 bucket):
 * the Protomaps Europe archive served one tile per URL, plus the plate's
 * glyphs and sprite — every response cacheable by browsers and the edge, and
 * CORS-open to any origin (spec/src/data-sources.md §Map tiles).
 */
const TILE_SERVICE = "https://placemarks-tiles.together-in-girona.workers.dev";

/**
 * Basemap, preferred path: our own plate style (src/map/basemapStyle.ts) over
 * the tile service's per-tile URLs. VITE_MAP_PMTILES_URL instead reads a
 * PMTiles archive directly by range request (no tile service; e.g. a local
 * extract in public/); VITE_MAP_STYLE_URL picks a hosted style (e2e's
 * network-free fixture does this). Precedence: tiles, then PMTiles, then
 * style. Relative paths resolve against the app's origin.
 */
export const MAP_TILES_URL: string | undefined =
  import.meta.env.VITE_MAP_TILES_URL ||
  (import.meta.env.VITE_MAP_PMTILES_URL || import.meta.env.VITE_MAP_STYLE_URL
    ? undefined
    : `${TILE_SERVICE}/europe/{z}/{x}/{y}.mvt`);

export const MAP_PMTILES_URL: string | undefined = MAP_TILES_URL
  ? undefined
  : import.meta.env.VITE_MAP_PMTILES_URL || undefined;

/** Glyphs for the plate style, served beside the tiles. */
export const MAP_GLYPHS_URL: string =
  import.meta.env.VITE_MAP_GLYPHS_URL ?? `${TILE_SERVICE}/fonts/{fontstack}/{range}.pbf`;

/** Sprite for the plate style, served beside the tiles. */
export const MAP_SPRITE_URL: string =
  import.meta.env.VITE_MAP_SPRITE_URL ?? `${TILE_SERVICE}/sprites/v4/light`;

/**
 * Hosted basemap, used only when VITE_MAP_STYLE_URL is set — e.g. OpenFreeMap
 * Positron (keyless, quiet grey, worldwide) for places outside the Europe
 * archive. Alternatives live in .env.example / spec/src/data-sources.md. E2e
 * sets a local, network-free style fixture.
 */
export const MAP_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron";

/**
 * Geocoder `search` kind (spec/src/data-sources.md §Geocoder): Photon-class by
 * default (keyless dev demo), or a Pelias-class autocomplete endpoint for real
 * POI/venue search (Stadia Maps, geocode.earth, self-hosted Pelias).
 */
export const GEOCODER_KIND: "photon" | "pelias" =
  import.meta.env.VITE_GEOCODER === "pelias" ? "pelias" : "photon";

/** Geocoder `search` — Photon-class forward geocoding (spec/src/data-sources.md). */
export const PHOTON_URL: string = import.meta.env.VITE_PHOTON_URL ?? "https://photon.komoot.io";

/** Pelias-class endpoint base. No default — Pelias has no keyless public demo. */
export const PELIAS_URL: string | undefined = import.meta.env.VITE_PELIAS_URL;

/** Optional Pelias key, sent as the `api_key` query param only — never a header. */
export const PELIAS_KEY: string | undefined = import.meta.env.VITE_PELIAS_KEY;

/**
 * Optional comma-separated Pelias `sources` filter, e.g.
 * `openstreetmap,foursquare,openaddresses` to opt in to a provider's extra
 * venue data. Unset = the provider's default source set.
 */
export const PELIAS_SOURCES: string | undefined = import.meta.env.VITE_PELIAS_SOURCES || undefined;

/** Geocoder `lookup` — exact element fetch for OSM element URL paste. */
export const OSM_API_URL: string =
  import.meta.env.VITE_OSM_API_URL ?? "https://api.openstreetmap.org";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors" as const;

/** Debounce for reporting the viewport — camera persistence, not discovery. */
export const VIEWPORT_DEBOUNCE_MS = 400;

/**
 * Share-service base URL (spec/src/sharing.md). Empty = same origin, which the
 * dev/e2e MSW worker intercepts; production points at the deployed Worker.
 */
export const SHARE_API_URL: string = import.meta.env.VITE_SHARE_API_URL ?? "";
