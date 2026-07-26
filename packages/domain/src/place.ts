/**
 * Durable place identity — an immutable app-owned PlaceId over a repairable OSM binding.
 * See spec/src/place-identity.md.
 */
import { type OsmElementRef, refKey } from "./osm";
import type { ResolvedPoi } from "./poi";

export type PlaceId = string;

export type ResolutionState =
  | "resolved"
  | "stale"
  | "unavailable"
  | "missing"
  | "needs-review"
  | "unlinked";

export interface OsmEvidence {
  ref: OsmElementRef;
  osmVersion?: number;
  source: "OpenStreetMap";
  license: "ODbL-1.0";
  attribution: "© OpenStreetMap contributors";
  name?: string;
  category: string;
  lat: number;
  lng: number;
  address?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  identityTags: Record<string, string>;
  observedAt: string;
}

export type RelinkReason = "replaced" | "merged" | "owner-confirmed" | "resolver-match";

export interface ManualFacts {
  name: string;
  lat: number;
  lng: number;
  category?: string;
  address?: string; // present on imported facts — Takeout carries addresses
  website?: string; // imported interchange fidelity (GeoJSON round-trips)
  phone?: string; // imported interchange fidelity (GeoJSON round-trips)
  openingHours?: string;
}

/**
 * A retained pointer into another ecosystem (spec/src/interop.md): provenance
 * and the deep link back. Opaque — the URL is never fetched.
 */
export interface ExternalRef {
  provider: "google-maps" | "web";
  url: string;
  /** Stable id parsed from the URL when present (feature-id pair or cid) — the dedup key. */
  fid?: string;
  importedAt: string;
}

export interface Place {
  id: PlaceId;
  origin: "osm" | "manual" | "import";
  currentOsmRef?: OsmElementRef; // absent on an unlinked manual/imported place
  currentOsmLinkedAt?: string;
  /**
   * Every OSM element this place has ever been linked to, current one excluded.
   *
   * A set, not a log. The interval shape it replaced recorded *when* and *why*
   * each link ended, which nothing read: its only two consumers are the dedup
   * key set below and export attribution. Keeping intervals cost an
   * append-only-prefix guard on every update, a composite sync merge key, an
   * interval-aware backup merge, and a schema refinement — all to protect data
   * with no reader. If link provenance is ever wanted, it belongs in an audit
   * surface, not on the aggregate every write has to preserve.
   */
  pastOsmRefs: OsmElementRef[];
  firstSeen?: OsmEvidence; // immutable recovery evidence, set when first OSM-linked
  lastVerified?: OsmEvidence; // last successfully resolved observation
  manual?: ManualFacts; // owner- or import-provided facts; required while unlinked
  externalRefs?: ExternalRef[];
  resolutionState: ResolutionState;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export function evidenceFromPoi(poi: ResolvedPoi): OsmEvidence {
  return {
    ref: poi.osmRef,
    ...(poi.osmVersion !== undefined ? { osmVersion: poi.osmVersion } : {}),
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    ...(poi.name ? { name: poi.name } : {}),
    category: poi.category,
    lat: poi.lat,
    lng: poi.lng,
    ...(poi.address ? { address: poi.address } : {}),
    ...(poi.website ? { website: poi.website } : {}),
    ...(poi.phone ? { phone: poi.phone } : {}),
    ...(poi.openingHours ? { openingHours: poi.openingHours } : {}),
    identityTags: poi.identityTags,
    observedAt: poi.resolvedAt,
  };
}

/** An OSM-origin place has a binding and firstSeen evidence from creation. */
export function createOsmPlace(id: PlaceId, poi: ResolvedPoi, now: string): Place {
  const evidence = evidenceFromPoi(poi);
  return {
    id,
    origin: "osm",
    currentOsmRef: poi.osmRef,
    currentOsmLinkedAt: now,
    pastOsmRefs: [],
    firstSeen: evidence,
    lastVerified: evidence,
    resolutionState: "resolved",
    createdAt: now,
    updatedAt: now,
  };
}

/** A manual place starts unlinked with owner-provided facts (spec/src/place-identity.md). */
export function createManualPlace(id: PlaceId, facts: ManualFacts, now: string): Place {
  return {
    id,
    origin: "manual",
    pastOsmRefs: [],
    manual: facts,
    resolutionState: "unlinked",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * An imported place (spec/src/interop.md) rides the manual-pin machinery:
 * unlinked, with imported facts and the source URL retained as an external ref.
 * OSM linkage is an optional upgrade, never an import gate.
 */
export function createImportedPlace(
  id: PlaceId,
  facts: ManualFacts,
  externalRef: ExternalRef | undefined,
  now: string,
): Place {
  return {
    id,
    origin: "import",
    pastOsmRefs: [],
    manual: facts,
    ...(externalRef ? { externalRefs: [externalRef] } : {}),
    resolutionState: "unlinked",
    createdAt: now,
    updatedAt: now,
  };
}

/** True when the place already carries this external ref (by fid, else exact URL). */
export function hasExternalRef(place: Place, ref: ExternalRef): boolean {
  return (place.externalRefs ?? []).some((existing) =>
    ref.fid && existing.fid ? existing.fid === ref.fid : existing.url === ref.url,
  );
}

/** Retain an external ref on a place; a no-op when an equivalent ref is present. */
export function withExternalRef(place: Place, ref: ExternalRef, now: string): Place {
  if (hasExternalRef(place, ref)) return place;
  return { ...place, externalRefs: [...(place.externalRefs ?? []), ref], updatedAt: now };
}

/**
 * Link an unlinked manual place, or relink an OSM-bound one to a replacement element.
 * Relinking appends one immutable completed interval to history and never rewrites entries.
 */
export function linkPlaceToOsm(
  place: Place,
  poi: ResolvedPoi,
  now: string,
  /** Why the link changed. Kept in the signature so callers stay explicit; not persisted. */
  _reason: RelinkReason,
): Place {
  const evidence = evidenceFromPoi(poi);
  // The outgoing ref joins the set; re-linking to one already there is a no-op.
  const past = place.currentOsmRef
    ? [
        ...place.pastOsmRefs.filter((ref) => refKey(ref) !== refKey(place.currentOsmRef!)),
        place.currentOsmRef,
      ]
    : place.pastOsmRefs;
  return {
    ...place,
    currentOsmRef: poi.osmRef,
    currentOsmLinkedAt: now,
    pastOsmRefs: past,
    firstSeen: place.firstSeen ?? evidence, // firstSeen is never overwritten
    lastVerified: evidence,
    resolutionState: "resolved",
    updatedAt: now,
  };
}

export interface DisplayFacts {
  name?: string;
  category?: string;
  lat: number;
  lng: number;
  address?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  /** Where these facts come from — the UI must label evidence and manual facts as non-live. */
  source: "osm-evidence" | "manual";
  observedAt?: string;
}

/** The durable display fallback: lastVerified evidence, or manual facts for unlinked pins. */
export function displayFacts(place: Place): DisplayFacts | undefined {
  if (place.lastVerified) {
    const ev = place.lastVerified;
    return {
      ...(ev.name ? { name: ev.name } : {}),
      category: ev.category,
      lat: ev.lat,
      lng: ev.lng,
      ...(ev.address ? { address: ev.address } : {}),
      ...(ev.website ? { website: ev.website } : {}),
      ...(ev.phone ? { phone: ev.phone } : {}),
      ...(ev.openingHours ? { openingHours: ev.openingHours } : {}),
      source: "osm-evidence",
      observedAt: ev.observedAt,
    };
  }
  if (place.manual) {
    return {
      name: place.manual.name,
      ...(place.manual.category ? { category: place.manual.category } : {}),
      lat: place.manual.lat,
      lng: place.manual.lng,
      ...(place.manual.address ? { address: place.manual.address } : {}),
      ...(place.manual.website ? { website: place.manual.website } : {}),
      ...(place.manual.phone ? { phone: place.manual.phone } : {}),
      ...(place.manual.openingHours ? { openingHours: place.manual.openingHours } : {}),
      source: "manual",
    };
  }
  return undefined;
}

export const DEFAULT_RESOLUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A resolved observation older than its TTL becomes stale (spec/src/storage-sync.md). */
export function isResolutionExpired(
  place: Place,
  nowIso: string,
  ttlMs: number = DEFAULT_RESOLUTION_TTL_MS,
): boolean {
  if (place.resolutionState !== "resolved" || !place.lastVerified) return false;
  const observed = Date.parse(place.lastVerified.observedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(observed) || Number.isNaN(now)) return false;
  return now - observed > ttlMs;
}

/** Every ref this place has ever been bound to — the index for exact-ref deduplication. */
export function allRefKeys(place: Place): string[] {
  const keys = new Set<string>();
  if (place.currentOsmRef) keys.add(refKey(place.currentOsmRef));
  for (const ref of place.pastOsmRefs) keys.add(refKey(ref));
  return [...keys];
}
