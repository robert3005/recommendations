# Data Model — Places, Lists & Posts

Everything in the library joins on an app-owned `PlaceId`. A place stores its facts flat — name,
coordinates, address, category — as the user's copy, with provenance refs (`googleUrl`, `appleUrl`,
`osmRef`) riding along as deep links, dedup keys, and the attribution trigger. Around places sit
lists (ordered, uniquely marked groups), posts (Markdown articles about one list or one place),
publications (the local records of published pages), and the working state of an import in
progress. All of it lives locally; see [Local Storage](./storage.md) for the stores and the
invariants the repository enforces transactionally.

## The library

The library owns places. A place is saved on its own — one press in the search field — and
exists whether or not anything groups it. Three kinds of group sit on top, each good at one job:

- **Tags** are the loose kind: free text the owner types, any number per place, many-to-many.
  A place also carries the owner's short **note**, a **rating**, and whether they have **been**
  or **want to go** — together the *personal layer*, the owner's own judgement of the place.
- **Saved views** are filters with a name — "tagged *date night*, rated great or better" — that
  keep themselves up to date as the library changes. They own no places.
- **Lists** are the hand-made kind: an ordered selection with a marker, an intro, and posts.
  A list is how a curation is *shown to other people* ([Sharing & Publishing](./sharing.md)).

A place can be on any number of lists, or none. Leaving a list never deletes a place, and
deleting a list keeps its places; only an explicit **Delete place** removes one, with all its
list entries, subject to the teardown refusals below. Lists themselves may be empty.

This replaced *membership is existence* on 2026-11-22 ([Decisions](./decisions.md)).

### Own tags and derived tags

Two different things are called tags, and they never mix:

- an **own tag** is the owner's word, stored on the place (`Place.tags`), normalised to lower
  case with collapsed whitespace, free text with no fixed vocabulary;
- a **derived tag** comes from the review classifier ([Review Insights](./reviews.md)) — other
  people's reviews, a fixed vocabulary, held in the separate insights store and never written
  onto the place.

Both can be searched and filtered, as separate facets, and they are always drawn differently
([Visual Design](./design.md) §Tags). A derived tag becomes an own tag only when the owner
presses it on the place card — a deliberate adoption, never a silent copy.

## Entities

```ts
type PlaceId = string;                       // app-owned UUID; all content joins on it

interface OsmRef { type: "node" | "way" | "relation"; id: string }

interface Place {
  id: PlaceId;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  origin: "google-link" | "apple-link" | "osm" | "takeout" | "mymaps-kml" | "search";
  googleUrl?: string;   // retained exactly as imported: deep link to the listing + dedup key
  appleUrl?: string;    // retained Apple Maps link when the place arrived by one
  osmRef?: OsmRef;      // set whenever facts came from OSM (link paste, search pick, geocoder
                        // placement): deep link, export identity, dedup key, attribution trigger
  imageUrl?: string;    // Wikimedia-hosted photo from the OSM element's tags, set at lookup time
  website?: string;     // richer POI facts, captured opportunistically at lookup — https only
  phone?: string;
  openingHours?: string;                       // the raw opening_hours tag value
  cuisine?: string;
  wheelchair?: string;                         // "yes" | "limited" | "no" only
  description?: string;
  descriptionSource?: "osm" | "wikipedia";     // which source filled description
  wikipediaUrl?: string;                       // the article a Wikipedia description came from
  // The personal layer: the owner's own, never filled by a provider or an import.
  tags?: string[];                             // own tags — normalised, sorted, unique
  note?: string;                               // a short note; published only with a list that shares notes
  rating?: 1 | 2 | 3;                          // good · great · favourite
  status?: "been" | "want";                    // absent = not said
  tagLog?: Record<string, { at: string; on: boolean }>;  // when each own tag was put on or
                                               // taken off — lets tags merge as a set between
                                               // devices (sync.md §Merging); never shown
  createdAt: string;
  updatedAt: string;
}

type MarkerShape =
  | "circle" | "diamond" | "triangle" | "square"
  | "hexagon" | "star" | "semicircle" | "chevron";

interface ListMarker { shape: MarkerShape; color: string }  // colour from the 8 accents

interface List {
  id: string;
  name: string;
  marker: ListMarker;
  description?: string; // the curator's intro; published with the list
  shareNotes?: boolean; // false = publish without the owner's notes, tags and ratings
  sourceKey?: string;   // import binding: Takeout CSV / Saved Places GeoJSON filename, or KML
                        // folder id, set on first import so re-imports follow local renames
  createdAt: string;
  updatedAt: string;
}

interface ListEntry {
  id: string;
  listId: string;
  placeId: PlaceId;
  rank: string;                               // fractional rank; order by (rank, id)
  createdAt: string;
  updatedAt: string;
}

interface SavedView {                          // a named filter; owns no places
  id: string;
  name: string;
  marker: ListMarker;                          // same 64-pair space as lists
  filter: PlaceFilter;
  createdAt: string;
  updatedAt: string;
}

interface PlaceFilter {                        // every present facet must hold
  text?: string;                               // every word, anywhere in the searchable text
  tags?: string[];                             // own tags — all of them
  derivedTags?: string[];                      // review-derived tags — all of them
  listIds?: string[];                          // on any of these lists
  minRating?: 1 | 2 | 3;
  status?: "been" | "want";
  unlisted?: boolean;                          // on no list
}

type PostTarget =
  | { kind: "list"; listId: string }
  | { kind: "place"; placeId: PlaceId };

interface Post {
  id: string;
  target: PostTarget;                          // immutable after creation
  title: string;
  body: string;                                // CommonMark + GFM Markdown
  createdAt: string;
  updatedAt: string;
}

interface Publication {
  id: string;
  target: { kind: "list" | "post"; id: string };
  slug: string;                                // public; /l/<slug> for lists, /p/<slug> for posts
  editorToken?: string;                        // device-held secret; absent = this device cannot
                                               // update/revoke (e.g. restored without credentials)
  lastPublishedHash?: string;                  // "unpublished changes" = current hash ≠ this
  publishedAt?: string;
  revokedAt?: string;                          // set on unpublish; row kept as a local tombstone
  createdAt: string;
  updatedAt: string;
}

interface ImportBatch {
  id: string;
  source: "takeout" | "mymaps-kml";
  fileName: string;
  startedAt: string;
  status: "reviewing" | "done" | "abandoned";
}

interface GeocoderCandidate {
  name: string; lat: number; lng: number; address?: string; osmRef?: OsmRef;
  imageUrl?: string;  // Wikimedia-hosted photo, set only by the exact OSM element lookup
  website?: string; phone?: string; openingHours?: string; cuisine?: string;
  wheelchair?: string; description?: string;   // POI facts from the element's tags (lookup only)
  wikipedia?: string; // the raw wikipedia tag value, "lang:Article Title"
}

interface ImportItem {
  id: string;
  batchId: string;
  targetListId: string;
  raw: { title: string; note?: string; url?: string; address?: string };
  coords?: { lat: number; lng: number };
  candidates?: GeocoderCandidate[];            // plain geocoder results; no scoring machinery
  status: "placed" | "review" | "skipped";
  placeId?: PlaceId;                           // set once materialised
}
```

Entries order by `(rank, id)`; a post's target never changes after creation (prose belonging to
another list or place is a new post). A `Publication` row is written at first publish and persists
after unpublish as a local tombstone; its editor token is the per-publication secret that
authorises update and revoke — see [Sharing & Publishing](./sharing.md). `ImportBatch` and
`ImportItem` are the working state of an import review and are described with the ladder and the
report in [Import & Export](./interop.md).

## Normative rules

- A place appears at most once per list. **Dedup precedence everywhere** (add, import,
  re-import): Google feature id (parsed from `googleUrl`) → `osmRef` → name + coordinate
  proximity, which prompts the user rather than merging silently.
- Facts on `Place` are the user's copy. **Geocoder results are OSM data**: any place created or
  placed from one (a search pick, ladder auto-placement, a review-queue candidate pick) records
  the result's `osmRef`. Manual placement by clicking the map yields user-provided coordinates
  and no `osmRef`. Exports attribute OSM (ODbL) exactly when `osmRef` is present. Wrong upstream
  facts are corrected on OpenStreetMap itself — the place card links out to the OSM element page
  whenever `osmRef` exists. An OSM element lookup may also capture a photo: `imageUrl` is set
  only from the element's `image` / `wikimedia_commons` tags and only when the URL is
  Wikimedia-hosted (`commons.wikimedia.org` / `upload.wikimedia.org`); any other host is ignored.
  The richer POI facts are captured the same opportunistic way: `website` (https only, from
  `website`/`contact:website`/`url`), `phone` (`phone`/`contact:phone`), `openingHours`,
  `cuisine`, `wheelchair` (`yes`/`limited`/`no` only), and `description` come from the OSM
  element's tags at lookup; a Wikipedia summary is consulted only when the element names an
  article (its `wikipedia` tag) and fills `description` (`descriptionSource: "wikipedia"`),
  `wikipediaUrl`, and the photo fallback. Captured facts fill only fields that are still
  missing — enrichment never overwrites a user-visible value.
- Post `body` link forms: `[text](place:<placeId>)` — a mention; the map focuses that place.
  `[text](post:<postId>)` — a cross-post link; this is how a list post links to place posts.
  Both are soft: a dangling target renders as plain text.
- **Post projection** (one rule, all surfaces): a post projects its target's places — a list
  post its list's members, a place post its one place. Mentions of places outside the
  projection render as plain text (the editor only offers projected pins, so they arise only
  when a place later leaves the list).
- Markdown pipeline (see [Posts](./posts.md)): remark-parse + remark-gfm → rehype-sanitize with
  an allowlist schema; raw HTML disabled; the local app allowlists `http:`/`https:`/`place:`/
  `post:` link protocols; external links get `rel="noopener noreferrer nofollow"`. Published
  bodies contain no custom protocols (rewritten at publish — see
  [Sharing & Publishing](./sharing.md)); the viewer allowlists only `http:`/`https:` and `#`
  fragments. Same parser and sanitizer everywhere.
- **Finding places**: a filter matches a place when every present facet holds. Free text is
  folded (lower case, diacritics and provider punctuation removed) and matches when *every word*
  appears somewhere in the place's searchable text — name, address, category, cuisine,
  description, the owner's note and tags, and the review-derived tags, summary and dish names —
  in any order. So "cosy italian soho" finds a place tagged *cosy*, serving Italian, on a Soho
  address. There is no ranking: results are the matches, in name order.
- **Personal layer**: tags normalise on write (trimmed, lower-cased, a leading `#` dropped,
  de-duplicated, sorted). Enrichment and import never write the personal layer.
- **Markers**: lists and saved views draw from one pair space. `shape` is one of the eight named shapes; with the eight accent colours the pair
  space is 64. Auto-assign the first free pair on list creation; imports take the nearest
  colour to the source style, then the first free pair; manual change in list edit mode picks shape
  first, then colour, swapping within free pairs. Uniqueness is enforced across live lists up to 64; beyond that, pairs
  repeat with a small numeral badge as the deterministic variant and the UI says so. On the map
  a pin renders as an anchored drop carrying the shape; in the notebook the marker is the flat
  shape itself. The accents and the drop treatment are in [Visual Design](./design.md).

## Teardown

Deletion runs bottom-up, and three refusals guard it:

1. Deleting a place is refused while posts target it; nothing is deleted or retargeted
   implicitly — the owner deletes the place posts first. Deleting a place removes its list
   entries with it. Taking a place off a list is not deletion and is never refused.
2. Deleting a list is refused until its posts are deleted. Its entries go with it; its places
   stay in the library.
3. Deleting a list or post with a live (unrevoked) publication is refused until the owner
   unpublishes it — no public page is ever orphaned by a local delete.

Nothing authored or published dies as a side effect of deleting something else. In-body
`place:`/`post:` links are soft — they degrade to plain text, never block anything.

## Relationships

```text
List ◀──1:*── ListEntry ──*:1──▶ Place ◀─ ─ ─ matches ─ ─ ─ SavedView.filter
  ▲                                ▲
  └───────── Post.target ──────────┘      exactly one list OR one place
  ▲
  └──── Publication.target ──▶ List | Post
```

## Why this shape

Durability comes from the app-owned `PlaceId`: entries, post targets, and mentions all join on it,
so a place's facts and provenance can change without moving anyone's writing. Every relationship
has one canonical owner — membership lives only in `ListEntry`, the owner's judgement only on
the `Place`, prose only in `Post`, publish state only in `Publication` — so each fact is edited in exactly one place and the teardown rules
have single points to guard. And because the model is a handful of flat, id-keyed rows, the
id-preserving library archive ([Import & Export](./interop.md)) can carry the whole library —
links and targets intact — while publishing projects it into self-contained public documents
([Sharing & Publishing](./sharing.md)).
