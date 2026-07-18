/**
 * Provider endpoints. The defaults are public/demo services and are DEVELOPMENT-ONLY
 * per book/src/data-sources.md — a production release must point these at contracted
 * or self-hosted deployments via VITE_* env configuration.
 */
/**
 * Default basemap: OpenFreeMap "liberty" — full street-level OSM vector tiles,
 * no API key, explicitly free to use (https://openfreemap.org). Still treated
 * as a swappable provider; production contracts land per book/src/data-sources.md.
 * E2e overrides this with a local, network-free style fixture.
 */
export const MAP_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

export const PHOTON_URL: string = import.meta.env.VITE_PHOTON_URL ?? "https://photon.komoot.io";

export const OSM_API_URL: string =
  import.meta.env.VITE_OSM_API_URL ?? "https://api.openstreetmap.org";

export const OVERPASS_URL: string =
  import.meta.env.VITE_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors" as const;

/** Viewport POI discovery budgets (book/src/data-sources.md §Viewport discovery). */
export const DISCOVER_MIN_ZOOM = 15;
export const DISCOVER_LIMIT = 60;
export const DISCOVER_DEBOUNCE_MS = 400;
