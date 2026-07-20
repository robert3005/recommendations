/**
 * Provider endpoints. The defaults are public/demo services and are DEVELOPMENT-ONLY
 * per spec/src/data-sources.md — a production release must point these at contracted
 * or self-hosted deployments via VITE_* env configuration.
 */
/**
 * Default basemap: OpenFreeMap "bright" — the OSM Bright GL style on full
 * street-level OSM vector tiles, no API key, explicitly free to use
 * (https://openfreemap.org). Alternatives for development live in
 * .env.example / spec/src/data-sources.md. Still a swappable provider;
 * production contracts land per the spec. E2e overrides this with a local,
 * network-free style fixture.
 */
export const MAP_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/bright";

export const PHOTON_URL: string = import.meta.env.VITE_PHOTON_URL ?? "https://photon.komoot.io";

export const OSM_API_URL: string =
  import.meta.env.VITE_OSM_API_URL ?? "https://api.openstreetmap.org";

export const OVERPASS_URL: string =
  import.meta.env.VITE_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors" as const;
/** Map-surface attribution links to the OSM copyright page (ODbL requirement). */
export const OSM_ATTRIBUTION_HTML =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>' as const;

/** Viewport POI discovery budgets (spec/src/data-sources.md §Viewport discovery). */
export const DISCOVER_MIN_ZOOM = 15;
export const DISCOVER_LIMIT = 60;
export const DISCOVER_DEBOUNCE_MS = 400;

/**
 * Share-service base URL (spec/src/sharing.md). Empty = same origin, which the
 * dev/e2e MSW worker intercepts; production points at the deployed Worker.
 */
export const SHARE_API_URL: string = import.meta.env.VITE_SHARE_API_URL ?? "";

/**
 * Sync-service base URL (spec/src/storage-sync.md §Multi-device sync). Empty =
 * same origin (MSW in dev/e2e); production points at the deployed service.
 */
export const SYNC_API_URL: string = import.meta.env.VITE_SYNC_API_URL ?? "";
