/**
 * Provider endpoints. The defaults are public/demo services and are DEVELOPMENT-ONLY
 * per spec/src/data-sources.md — a production release must point these at contracted
 * or self-hosted deployments via VITE_* env configuration (the build fails closed).
 */
/**
 * Our tile bucket (Cloudflare R2, public r2.dev URL): the Protomaps Europe
 * archive plus the plate's glyphs and sprite (spec/src/data-sources.md §Map tiles).
 */
const TILE_BUCKET = "https://pub-a5fdf113afab4f329db5d4a74129b60d.r2.dev";

/**
 * Basemap, preferred path: our own plate style (src/map/basemapStyle.ts) built
 * from a Protomaps-schema PMTiles archive — self-hosted static storage, no
 * per-view billing. Defaults to the bucket's archive unless a hosted style is
 * chosen explicitly with VITE_MAP_STYLE_URL (e2e's network-free fixture does
 * this). Relative paths resolve against the app's origin.
 */
export const MAP_PMTILES_URL: string | undefined =
  import.meta.env.VITE_MAP_PMTILES_URL ||
  (import.meta.env.VITE_MAP_STYLE_URL ? undefined : `${TILE_BUCKET}/europe.pmtiles`);

/** Glyphs for the plate style, served beside the archive. */
export const MAP_GLYPHS_URL: string =
  import.meta.env.VITE_MAP_GLYPHS_URL ?? `${TILE_BUCKET}/fonts/{fontstack}/{range}.pbf`;

/** Sprite for the plate style, served beside the archive. */
export const MAP_SPRITE_URL: string =
  import.meta.env.VITE_MAP_SPRITE_URL ?? `${TILE_BUCKET}/sprites/v4/light`;

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
 * POI/venue search (Stadia Maps, Geoapify, geocode.earth, self-hosted Pelias).
 */
export const GEOCODER_KIND: "photon" | "pelias" =
  import.meta.env.VITE_GEOCODER === "pelias" ? "pelias" : "photon";

/** Geocoder `search` — Photon-class forward geocoding (spec/src/data-sources.md). */
export const PHOTON_URL: string = import.meta.env.VITE_PHOTON_URL ?? "https://photon.komoot.io";

/** Pelias-class endpoint base. No default — Pelias has no keyless public demo. */
export const PELIAS_URL: string | undefined = import.meta.env.VITE_PELIAS_URL;

/** Optional Pelias key, sent as the `api_key` query param only — never a header. */
export const PELIAS_KEY: string | undefined = import.meta.env.VITE_PELIAS_KEY;

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
