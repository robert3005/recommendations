# Data Model — Places, Lists & Posts

Everything in the library joins on an app-owned `PlaceId`. A place stores its facts flat — name,
coordinates, address, category — as the user's copy, with provenance refs (`googleUrl`, `appleUrl`,
`osmRef`) riding along as deep links, dedup keys, and the attribution trigger. Around places sit
lists (ordered, uniquely marked groups), posts (Markdown articles about one list or one place),
publications (the local records of published pages), and the working state of an import in
progress. All of it lives locally; see [Local Storage](./storage.md) for the stores and the
invariants the repository enforces transactionally.

## Membership is existence

A place exists in the library iff it belongs to at least one list. The only door through which a
place comes to exist is being added to a list: the add-a-place field, the place card's **Add to
list**, and [import](./interop.md) all end in "pick a list". There is no standalone save, no
orphan pool — and the rule is load-bearing for the visual system, because an unlisted place would
have no marker to wear. Removing a place's last entry removes the place, subject to the teardown
refusals below. Lists themselves may be empty: membership-is-existence constrains places, not
lists — a freshly created list exists before any place joins it.

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
- **Markers**: `shape` is one of the eight named shapes; with the eight accent colours the pair
  space is 64. Auto-assign the first free pair on list creation; imports take the nearest
  colour to the source style, then the first free pair; manual change in list edit mode swaps
  within free pairs. Uniqueness is enforced across live lists up to 64; beyond that, pairs
  repeat with a small numeral badge as the deterministic variant and the UI says so. Pins are
  solid accent-coloured shapes (no glyph cutouts). The accents are named in
  [Visual Design](./design.md).

## Teardown

Deletion runs bottom-up, and three refusals guard it:

1. Deleting a place — removing its last entry — is refused while posts target it; the owner
   deletes or retargets nothing implicitly, they delete the place posts first.
2. Deleting a list is refused until it is empty and its posts are deleted.
3. Deleting a list or post with a live (unrevoked) publication is refused until the owner
   unpublishes it — no public page is ever orphaned by a local delete.

Nothing authored or published dies as a side effect of deleting something else. In-body
`place:`/`post:` links are soft — they degrade to plain text, never block anything.

## Relationships

```text
List ◀──1:*── ListEntry ──*:1──▶ Place
  ▲                                ▲
  └───────── Post.target ──────────┘      exactly one list OR one place
  ▲
  └──── Publication.target ──▶ List | Post
```

## Why this shape

Durability comes from the app-owned `PlaceId`: entries, post targets, and mentions all join on it,
so a place's facts and provenance can change without moving anyone's writing. Every relationship
has one canonical owner — membership lives only in `ListEntry`, prose only in `Post`, publish
state only in `Publication` — so each fact is edited in exactly one place and the teardown rules
have single points to guard. And because the model is a handful of flat, id-keyed rows, the
id-preserving library archive ([Import & Export](./interop.md)) can carry the whole library —
links and targets intact — while publishing projects it into self-contained public documents
([Sharing & Publishing](./sharing.md)).
