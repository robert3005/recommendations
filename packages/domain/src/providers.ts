/**
 * External service adapter contracts — spec/src/architecture.md §4.
 * Adapters own schema mapping, budgets, retry/failure behavior, and attribution.
 */
import type { BBox } from "./geo";
import type { OsmElementRef } from "./osm";
import type { ResolvedPoi } from "./poi";
import type { ExactOutcome } from "./resolution";

/** A search result that can become a saved place must carry a typed OSM reference. */
export interface SearchResult {
  ref: OsmElementRef;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  address?: string;
}

export interface SearchProvider {
  search(
    query: string,
    opts?: { signal?: AbortSignal; bias?: { lat: number; lng: number }; limit?: number },
  ): Promise<SearchResult[]>;
}

export interface DiscoverResult {
  pois: ResolvedPoi[];
  /** True when the provider capped results — the UI must indicate truncation. */
  truncated: boolean;
}

export interface PoiResolver {
  /** Fetch the exact element. `gone` only on a definitive missing/deleted answer. */
  resolveExact(ref: OsmElementRef, opts?: { signal?: AbortSignal }): Promise<ExactOutcome>;
  /** Candidate search near a point, for long-press pickers and identity recovery. */
  searchNearby(params: {
    lat: number;
    lng: number;
    radiusM: number;
    signal?: AbortSignal;
  }): Promise<ResolvedPoi[]>;
  /** Bounded viewport discovery with explicit budgets. */
  discover(bbox: BBox, opts?: { signal?: AbortSignal; limit?: number }): Promise<DiscoverResult>;
}

export interface MapStyleConfig {
  styleUrl: string;
  /** OSM attribution is a licensing requirement, not a preference. */
  attribution: "© OpenStreetMap contributors";
}
