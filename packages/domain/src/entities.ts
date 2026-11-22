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
  imageUrl?: string; // Wikimedia-hosted photo from the OSM element's image/wikimedia_commons
  // tags, captured at lookup time; never any other host
  // Richer POI facts, captured opportunistically from OSM tags at lookup and
  // from a Wikipedia summary when the element names an article; each fills
  // only while missing (spec/src/data-model.md §Normative rules).
  website?: string; // https only
  phone?: string;
  openingHours?: string; // the raw opening_hours tag value
  cuisine?: string;
  wheelchair?: string; // "yes" | "limited" | "no" — other tag values are dropped at capture
  description?: string;
  descriptionSource?: "osm" | "wikipedia"; // which source filled description
  wikipediaUrl?: string; // the article page a Wikipedia-sourced description came from
  // The owner's own judgement (spec/src/data-model.md §The personal layer):
  // never filled by a provider, never overwritten by enrichment or import.
  tags?: string[]; // own tags, normalised by normalizeTag; sorted, unique
  note?: string; // a short private note; published only on explicit opt-in
  rating?: PlaceRating; // 1 good · 2 great · 3 favourite
  status?: PlaceStatus; // "been" | "want"; absent = not said
  createdAt: string;
  updatedAt: string;
}

export type PlaceRating = 1 | 2 | 3;
export type PlaceStatus = "been" | "want";

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
  description?: string; // the curator's intro; published with the list
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

/**
 * A saved filter over the library (spec/src/data-model.md §Saved views): the
 * loose, self-updating kind of group. A view owns no places — it is evaluated
 * against the library every time it is shown — and wears a marker from the
 * same pair space as lists, so the two layer on the map without colliding.
 */
export interface SavedView {
  id: string;
  name: string;
  marker: ListMarker;
  filter: PlaceFilter;
  createdAt: string;
  updatedAt: string;
}

/** Every present facet must hold (AND); within `listIds` any one suffices. */
export interface PlaceFilter {
  text?: string; // free text over name, tags, note, facts, and review text
  tags?: string[]; // own tags — the place carries every one
  derivedTags?: string[]; // review-derived tags — the place carries every one
  listIds?: string[]; // on any of these lists
  minRating?: PlaceRating;
  status?: PlaceStatus;
  unlisted?: boolean; // on no list at all
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
  imageUrl?: string; // Wikimedia-hosted photo, set only by the exact OSM element lookup
  // Richer POI facts, mapped from the element's tags by the exact lookup only.
  website?: string; // https only
  phone?: string;
  openingHours?: string;
  cuisine?: string;
  wheelchair?: string; // "yes" | "limited" | "no" only
  description?: string; // the OSM description tag
  wikipedia?: string; // the raw wikipedia tag value, "lang:Article Title"
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
