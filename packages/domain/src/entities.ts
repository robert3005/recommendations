/** The entity model, transcribed from spec/src/data-model.md §Entities. */

export type PlaceId = string; // app-owned UUID; all content joins on it

export interface OsmRef {
  type: "node" | "way" | "relation";
  id: string;
}

export interface Place {
  id: PlaceId;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  origin: "google-link" | "apple-link" | "osm" | "takeout" | "mymaps-kml" | "search";
  googleUrl?: string; // retained exactly as imported: deep link to the listing + dedup key
  appleUrl?: string; // retained Apple Maps link when the place arrived by one
  osmRef?: OsmRef; // set whenever facts came from OSM (link paste, search pick, geocoder
  // placement): deep link, export identity, dedup key, attribution trigger
  createdAt: string;
  updatedAt: string;
}

export type MarkerShape =
  | "circle"
  | "diamond"
  | "triangle"
  | "square"
  | "hexagon"
  | "star"
  | "semicircle"
  | "chevron";

/** Colour from the 8 accents (spec/src/design.md). */
export interface ListMarker {
  shape: MarkerShape;
  color: string;
}

export interface List {
  id: string;
  name: string;
  marker: ListMarker;
  sourceKey?: string; // import binding: Takeout CSV / Saved Places GeoJSON filename, or KML
  // folder id, set on first import so re-imports follow local renames
  createdAt: string;
  updatedAt: string;
}

export interface ListEntry {
  id: string;
  listId: string;
  placeId: PlaceId;
  rank: string; // fractional rank; order by (rank, id)
  createdAt: string;
  updatedAt: string;
}

export type PostTarget = { kind: "list"; listId: string } | { kind: "place"; placeId: PlaceId };

export interface Post {
  id: string;
  target: PostTarget; // immutable after creation
  title: string;
  body: string; // CommonMark + GFM Markdown
  createdAt: string;
  updatedAt: string;
}

export interface Publication {
  id: string;
  target: { kind: "list" | "post"; id: string };
  slug: string; // public; /l/<slug> for lists, /p/<slug> for posts
  editorToken?: string; // device-held secret; absent = this device cannot
  // update/revoke (e.g. restored without credentials)
  lastPublishedHash?: string; // "unpublished changes" = current hash ≠ this
  publishedAt?: string;
  revokedAt?: string; // set on unpublish; row kept as a local tombstone
  createdAt: string;
  updatedAt: string;
}

export interface ImportBatch {
  id: string;
  source: "takeout" | "mymaps-kml";
  fileName: string;
  startedAt: string;
  status: "reviewing" | "done" | "abandoned";
}

export interface GeocoderCandidate {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  osmRef?: OsmRef;
}

export interface ImportItem {
  id: string;
  batchId: string;
  targetListId: string;
  raw: { title: string; note?: string; url?: string; address?: string };
  coords?: { lat: number; lng: number };
  candidates?: GeocoderCandidate[]; // plain geocoder results; no scoring machinery
  status: "placed" | "review" | "skipped";
  placeId?: PlaceId; // set once materialised
}

/** Deterministic ordering: rank, then id as the tiebreaker. */
export function compareByRank<T extends { rank: string; id: string }>(a: T, b: T): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Canonical index key for a post's target: "list:<id>" | "place:<id>". */
export function postTargetKey(t: PostTarget): string {
  return t.kind === "list" ? `list:${t.listId}` : `place:${t.placeId}`;
}

/** Canonical index key for a publication's target: "list:<id>" | "post:<id>". */
export function publicationTargetKey(t: Publication["target"]): string {
  return `${t.kind}:${t.id}`;
}

/** Canonical string form of an OSM element ref, e.g. "node/123". */
export function osmRefKey(r: OsmRef): string {
  return `${r.type}/${r.id}`;
}
