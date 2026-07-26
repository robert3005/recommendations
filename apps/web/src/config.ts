/**
 * Provider endpoints. The defaults are public/demo services and are DEVELOPMENT-ONLY
 * per spec/src/data-sources.md — a production release must point these at contracted
 * or self-hosted deployments via VITE_* env configuration (the build fails closed).
 */
/**
 * Default basemap: OpenFreeMap "bright" — the OSM Bright GL style on full
 * street-level OSM vector tiles, no API key, explicitly free to use
 * (https://openfreemap.org). Alternatives for development live in
 * .env.example / spec/src/data-sources.md. E2e overrides this with a local,
 * network-free style fixture.
 */
export const MAP_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/bright";

/** Geocoder `search` — Photon-class forward geocoding (spec/src/data-sources.md). */
export const PHOTON_URL: string = import.meta.env.VITE_PHOTON_URL ?? "https://photon.komoot.io";

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
