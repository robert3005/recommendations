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

/**
 * The map-style boundary (spec/src/architecture.md §External service
 * adapters): the canvas consumes a typed style + attribution capability, not
 * a raw URL constant — providers stay replaceable through contracts.
 */
export interface MapStyleProvider {
  style(): MapStyleConfig;
}

/**
 * Bearer-authorized publish/revoke of EXPLICIT publication jobs
 * (spec/src/architecture.md): the publisher drains only the durable
 * publication outbox — it never auto-publishes local edits, and a failed
 * network effect never rolls back a committed local change.
 */
export interface SharePublisher {
  /** Retry interrupted explicit jobs from the durable outbox (launch/reconnect). */
  drainOutbox(): Promise<void>;
  /** Queue and send revocation for a publication; retries reuse its job. */
  revoke(publicationId: string): Promise<void>;
}
