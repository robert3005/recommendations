# Places, Lists & Posts — Data Model

The model separates two kinds of data:

1. **OSM observations** — source facts that Placemarks copies for display, offline fallback, and
   identity recovery. OSM remains the upstream source of truth.
2. **Owned data** — durable place identities, list memberships, tags, notes, posts, imported
   facts/external refs, and publication state.

There is deliberately no Placemarks-wide POI contribution layer. If a website, phone number,
opening time, location, or POI is wrong or missing, the product sends the user to
[OpenStreetMap](./place-identity.md#correcting-or-adding-osm-data) to improve the source.

## Place identity and OSM binding

An OSM element id is not the durable identity of a real-world place. Every persisted place gets an
immutable app-owned `PlaceId`; its OSM link may be repaired without moving the user's notes, tags,
list memberships, or post embeds to a new identity.

```ts
type PlaceId = string;
type OsmElementType = "node" | "way" | "relation";

interface OsmElementRef {
  type: OsmElementType;
  id: string;
}

interface OsmEvidence {
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

interface ManualFacts {
  name: string;
  lat: number;
  lng: number;
  category?: string;
  address?: string;            // present on imported facts (Takeout carries addresses)
}

/** A retained pointer into another ecosystem — provenance and deep link, never fetched. */
interface ExternalRef {
  provider: "google-maps";     // more later if other exports appear
  url: string;                 // as imported; its embedded feature id is the dedup key
  importedAt: string;
}

interface Place {
  id: PlaceId;
  origin: "osm" | "manual" | "import";
  // OSM binding — present from creation when origin is "osm";
  // absent on an unlinked manual/imported place until one is linked.
  currentOsmRef?: OsmElementRef;
  currentOsmLinkedAt?: string;
  /**
   * Every OSM element this place has been linked to, current one excluded — a
   * SET, not a log. Its readers are the dedup key set and export attribution;
   * neither needs when or why a link ended, and recording that cost an
   * append-only-prefix guard on every write. Link provenance, if ever wanted,
   * belongs in an audit surface rather than on the aggregate.
   */
  pastOsmRefs: OsmElementRef[];
  firstSeen?: OsmEvidence;     // set when first OSM-linked
  lastVerified?: OsmEvidence;  // set after the first successful resolution
  manual?: ManualFacts;        // owner- or import-provided facts; required while unlinked
  externalRefs?: ExternalRef[]; // e.g. the Google Maps URL an import arrived with
  resolutionState: "resolved" | "stale" | "unavailable" | "missing" | "needs-review" | "unlinked";
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

An **OSM-origin** place always carries a binding and evidence. A **manual** place is a deliberate,
clearly-labeled local pin for a spot that is not in OSM — or should never be (a picnic bench, a
meeting point): it starts in `unlinked` state with owner-provided `ManualFacts` and no OSM data,
and may later be upgraded through the same candidate picker, entering the normal resolution
lifecycle. An **import-origin** place ([Import & Export](./interop.md)) rides the same
machinery: imported facts fill `ManualFacts`, the source URL is retained in `externalRefs`
(provenance + deep link — an opaque pointer that is never fetched), and OSM linkage is an
optional upgrade, either automatic when import-time matching is confident or later via the
picker. Imported Google-derived facts never pre-fill OSM contributions
([licensing hygiene](./interop.md#licensing-hygiene)). `firstSeen` is immutable recovery evidence
once set. `lastVerified` is the latest successful observation and the only durable POI fallback;
there is no second `cachedPoi` authority. See
[Durable Place Identity](./place-identity.md) for creation, refresh, conservative relinking, and
deduplication rules.

## Resolved POI (transient source view)

The resolver turns the current OSM element into displayable fields. This object is transient; a
successful resolution produces the next `lastVerified` observation on `Place`.

```ts
interface ResolvedPoi {
  osmRef: OsmElementRef;
  osmVersion?: number;
  name?: string;               // not every OSM feature is named
  category: string;            // derived from amenity/shop/tourism/… tags
  lat: number;
  lng: number;
  address?: string;
  website?: string;            // website → contact:website → url
  phone?: string;
  openingHours?: string;
  socials?: Record<string, string>;
  identityTags: Record<string, string>;
  resolvedAt: string;
}
```

External URLs are untrusted data. Only normalized `http:` and `https:` destinations are rendered
as links, with safe external-link attributes and a restrictive Content Security Policy.

## Membership is existence (no saves)

There is **no standalone "save" entity** (2026-07-18: the notion of saves was removed). A place
exists in the library **iff it belongs to at least one list**:

- The only way a place comes to exist is being **added to a list** (from its card, from the
  manual pin dialog — which therefore requires choosing a list — or by an
  [import](./interop.md) materializing rows into their list).
- Removing a place's **last** membership removes the place — but the removal is **refused while
  the place carries live notes or live post embeds** (bottom-up teardown, 2026-07-19 late —
  [Posts](./posts.md#where-embeds-come-from)): the owner deletes their notes and embeds first,
  then the removal deletes the place with its tag assignments in one transaction. Authored
  content never dies as a side effect.
- Tag assignments and list blocks join directly on `PlaceId`. Reverse relationships are queries,
  not duplicated arrays.

## Note (personal, rich page, eligible for sharing)

A note is a Markdown page anchored to either a place or a post (list-targeted notes were
retargeted to posts by the 2026-07-19 pivot):

- **Place notes** — write-ups about a single durable `PlaceId`; a place can have several.
- **Post sections** — narrative passages of a [post](./posts.md), interleaved with place embeds.

```ts
type NoteTarget =
  | { kind: "place"; placeId: PlaceId }
  | { kind: "post"; postId: string };

interface Note {
  id: string;
  /** Immutable: prose belonging elsewhere is created there. */
  target: NoteTarget;
  title?: string;
  body: string;                // CommonMark + GFM source of truth
  /** PLACE notes only: eligibility to appear publicly. A post's prose publishes with its post. */
  shareable: boolean;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

`shareable` permits a *place* note to be selected into a public projection; it does not mean the
note is currently public. Publication and revocation state live in `Publication`. Turning it off
prevents new publication and queues removal from existing hosted publications. A post note ignores
the flag: its post's prose publishes with the post.

## MediaAsset

The entity stores portable metadata. Binary bytes live in the IndexedDB media store under
`localBlobKey`, outside the domain object. Media is **device-local**: the bytes do not sync, so the
metadata row does not either — replicating it would hand another device a `localBlobKey` pointing at
nothing. Hosted views carry a text placeholder until a media service exists.

```ts
interface MediaAsset {
  id: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
  localBlobKey: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

## Tags and assignments

Tags are reusable; assignments are independently mergeable edges.

```ts
interface Tag {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

interface TagAssignment {
  id: string;
  placeId: PlaceId;
  tagId: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

The repository enforces one live assignment for each `(placeId, tagId)` pair. Tag names are
normalized for uniqueness while preserving the user's display casing.

## List (a named group of places)

A list is a **named, marked, ordered group of places — nothing more** (2026-07-18: descriptions
were removed; 2026-07-19: section blocks moved to posts). A list may be **empty**:
membership-is-existence constrains places, not lists — a list created on the Lists tab exists
before any place joins it. Editorial prose about a list lives in [posts](./posts.md), never on
the list. Blocks are their own entities so adding, removing, or reordering one item does not
replace a whole array during sync.

```ts
interface ListMarker {
  color: string;               // palette colour
  icon: string;                // symbol from the app's marker icon set
}

interface List {
  id: string;
  name: string;
  marker: ListMarker;          // unique per live list; worn by its places' pins on the map
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

interface ListBlock {
  id: string;
  listId: string;
  rank: string;                // sortable fractional rank
  content: { type: "place"; placeId: PlaceId };
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

The **marker** replaces the earlier colour-only field (2026-07-19): on the all-lists map, points
from each list must be attributable at a glance, and colour alone runs out of legible distinctions
fast. A marker is a `(colour, icon)` pair, auto-assigned as the next unused combination and
user-adjustable; the repository keeps live markers unique. Existing `color` values migrate to
`marker.color` with an auto-assigned icon.

Membership is the set of live place blocks, ordered by `(rank, id)` with deterministic rank
rebalancing when ranks become dense or collide. A place may appear at most once in a list.

## Post (an editorialised list)

A [post](./posts.md) is the editorial layer — **an editorialised list**.
Each post editorialises exactly one list, interleaving narrative sections with embeds of that
list's places; a list may have several posts.

```ts
interface Post {
  id: string;
  title: string;
  listId: string;              // the list this post editorialises
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

type PostBlockContent =
  | { type: "section"; noteId: string }   // a post-targeted note
  | { type: "place"; placeId: PlaceId };  // an embed of a library place

interface PostBlock {
  id: string;
  postId: string;
  rank: string;                // sortable fractional rank
  content: PostBlockContent;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

interface BlockNoteAttachment {
  id: string;
  blockId: string;             // must identify a post place block
  noteId: string;              // a shareable place note
  rank: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

Post blocks order like list blocks. An attached note is an explicit, durable edge rather than an
ephemeral publish-UI choice. Tags are **not** published: per-embed tag selection existed as its own
entity and was removed on 2026-07-26 — the shipped list projection already shared no tags, and the
wire field remains optional so the capability can return additively. A place embed **references** a member of
the post's list; it never sustains the place's existence — instead a live embed **blocks** the
place's removal from that list until the author removes the embed
([bottom-up teardown](./posts.md#where-embeds-come-from)).

Repository transactions enforce these cross-entity invariants:

- a section note targets the same post as its section block;
- a live place embed's place is a live member of the post's list;
- an attached place note targets the same `PlaceId` as the embed's place;
- live `(blockId, noteId)` edges are unique.

## Publication state

Public documents and private editing capabilities are not stored on `List` or `Note`. They live in
a separate local entity so public content, local draft state, credentials, retries, and revocation
cannot be confused.

```ts
interface Publication {
  id: string;
  target: { kind: "list" | "post"; id: string };
  slug?: string;               // public and guessable; the path segment follows target.kind
  credentialId?: string;       // points to a private local editor bearer token
  status: "queued" | "publishing" | "published" | "failed" | "revoking" | "revoked";
  publishedRevision?: number;  // server revision / ETag
  /**
   * The projection hash of the last successful publish. "Changes pending" is
   * this compared with the target's CURRENT projection hash — one source of
   * truth, rather than a dirty bit maintained on every write path.
   */
  lastPublishedHash?: string;
  publishedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

A hosted publication requires a high-entropy editor bearer token from creation onward. Snapshot
links carry no publication record at all — they are a document in a URL fragment, with nothing to
update or revoke. The token is never included in a public URL
or shared document. See [Lists & Sharing](./sharing.md).

## What the UI displays

There is no merge with app-wide user corrections. The current v1 surface uses:

```text
displayed place = Place.lastVerified facts for an OSM-linked place
                  or Place.manual facts with an "unlinked" badge
```

TTL refresh, evidence timestamps, and stale/error badges belong to the deferred freshness surface;
stored evidence is not described as a fresh live observation. Personal notes and post prose are
separate owned content. Wrong OSM facts lead to the **View on OpenStreetMap** portal, where the
user may inspect/edit/report the source. The app retries search or matching only after upstream
services update. This keeps one public geographic source and avoids introducing a second
moderation-heavy places database.

## Relationships

```text
List ──1:*── ListBlock ──place──▶ PlaceId ──▶ Place
  │                                  ▲ │          │
  │   ┌── Post (listId) ─1:*─ PostBlock┘├─* TagAssignment ─▶ Tag
  └───┤        │                │       └─* Note  │
      │        ├─section──▶ Note│                 ├─▶ current OSM ref + evidence
      │        ├─* BlockNoteAttachment ──▶ Note   └─▶ external refs (imports)
      │
      └──────────────── Publication (list | post | note)
```

- Deleting a list is **refused until it is empty and no live posts editorialise it**
  (bottom-up teardown, 2026-07-19 late — [Posts](./posts.md#where-embeds-come-from)): places
  leave first (Edit mode offers a bulk **Remove all places** that names any blockers), posts are
  deleted first, and only then does the empty list delete. Nothing cascades through it.
- Deleting a post tombstones its blocks, its own section notes and attachments; it never touches
  the list, its places, or place notes.
- Removing a place from a list is refused while a post about that list embeds it; the removal
  that would delete the place outright is additionally refused while the place has live notes.
  Once clear, removal tombstones its tag assignments and place blocks; it never changes OSM.
- Deleting a published target queues **revocation** — a deleted aggregate never orphans its public
  page. The old public revision remains visible until the revocation succeeds.
- Every other edit simply makes the publication out of date; nothing is queued and nothing
  auto-publishes. There is no dirty bit: "changes pending" is the target's current projection hash
  compared with `lastPublishedHash`, computed on read. A shared post projects its own blocks, not
  the list's, so list membership changes reach a post's publication only through its own embeds.
- A replaced OSM element joins `pastOsmRefs`, so evidence-based recovery and dedup can still find
  the place by its former ref;
  notes, list membership, and post embeds stay attached to the same `PlaceId`.

## Why this separation matters

- **Durability:** user content joins through `PlaceId`, surviving OSM node/way/relation replacement.
- **Recoverability:** first-seen and last-verified evidence support conservative re-resolution and
  useful offline display.
- **Consistency:** membership, ordering, tags, and note attachment have one canonical
  representation and can be changed transactionally.
- **Portability:** exports include owned entities plus the bounded, attributed OSM evidence needed
  to preserve identity; binary media travels separately in the archive.
- **Sync readiness:** timestamps are useful metadata, while mutation ids, per-edge changes, server
  cursors, and tombstones provide ordering. Client wall clocks alone are not a conflict protocol.
- **Privacy:** private notes are eligible for publication only by explicit selection, and public
  editing capabilities never enter the shared document.
