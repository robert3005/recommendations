# Places, Tags & Lists — Data Model

The model separates two kinds of data:

1. **OSM observations** — source facts that Placemarks copies for display, offline fallback, and
   identity recovery. OSM remains the upstream source of truth.
2. **Owned data** — durable place identities, list memberships, tags, notes, guides, imported
   facts/external refs, and publication state.

There is deliberately no Placemarks-wide POI contribution layer. If a website, phone number,
opening time, location, or POI is wrong or missing, the product sends the user to
[OpenStreetMap](./place-identity.md#correcting-or-adding-osm-data) to improve the source.

## Place identity and OSM binding

An OSM element id is not the durable identity of a real-world place. Every persisted place gets an
immutable app-owned `PlaceId`; its OSM link may be repaired without moving the user's notes, tags,
or guide entries to a new identity.

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
  osmRefHistory: Array<{
    ref: OsmElementRef;
    linkedAt: string;
    unlinkedAt?: string;
    reason?: "replaced" | "merged" | "owner-confirmed" | "resolver-match";
  }>;
  firstSeen?: OsmEvidence;     // set when first OSM-linked
  lastVerified?: OsmEvidence;  // set after the first successful resolution
  manual?: ManualFacts;        // owner- or import-provided facts; required while unlinked
  externalRefs?: ExternalRef[]; // e.g. the Google Maps URL an import arrived with
  resolutionState: "resolved" | "stale" | "unavailable" | "missing" | "needs-review" | "unlinked";
  lastResolutionAttemptAt?: string;
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
- Removing a place's **last** membership — by removing the block, or deleting the list that held
  it — removes the place together with its tags and notes, in the same transaction.
- Tag assignments and list blocks join directly on `PlaceId`. Reverse relationships are queries,
  not duplicated arrays.

## Note (personal, rich page, eligible for sharing)

A note is a Markdown page anchored to either a place or a list:

- **Place notes** — write-ups about a single durable `PlaceId`; a place can have several.
- **List notes** — narrative sections of a guide, interleaved with place blocks.

```ts
type NoteTarget =
  | { kind: "place"; placeId: PlaceId }
  | { kind: "list"; listId: string };

interface Note {
  id: string;
  target: NoteTarget;
  title?: string;
  body: string;                // CommonMark + GFM source of truth
  mediaIds: string[];
  shareable: boolean;          // eligibility only; default false
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

`shareable` permits a note to be selected for a guide or note-page publication; it does not mean
the note is currently public. Publication and revocation state live in `Publication`. Turning it
off prevents new publication and queues removal from existing hosted publications.

## MediaAsset

The entity stores portable metadata. Binary bytes live in the IndexedDB media store under
`localBlobKey`, outside the domain object; hosted views reference a server-issued media id rather
than an arbitrary client URL.

```ts
interface MediaAsset {
  id: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
  localBlobKey: string;
  hostedMediaId?: string;
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

A list is a **named, ordered group of places — nothing more** (2026-07-18: descriptions were
removed; lists have names). A **guide is an editorialised list**: the same list enriched with the
editorial layer — prose descriptions, interleaved narrative sections, attached notes, a reading
experience. That layer arrives at the guide milestone; descriptive text belongs to it, not to the
list. Blocks are their own entities so adding, removing, or reordering one item does not replace
a whole array during future sync.

```ts
interface List {
  id: string;
  name: string;
  color?: string; // the list's user-selected marker colour, worn by its places' pins
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

type ListBlockContent =
  | { type: "section"; noteId: string }
  | { type: "place"; placeId: PlaceId };

interface ListBlock {
  id: string;
  listId: string;
  rank: string;                // sortable fractional rank
  content: ListBlockContent;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

interface BlockNoteAttachment {
  id: string;
  blockId: string;             // must identify a place block
  noteId: string;              // a shareable place note
  rank: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

interface BlockTagSelection {
  id: string;
  blockId: string;             // must identify a place block
  tagId: string;               // tag assigned to that block's place
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

Membership is the set of live place blocks, ordered by `(rank, id)` with deterministic rank
rebalancing when ranks become dense or collide. A simple list contains only place blocks; adding
section blocks turns it into a narrative guide. A place may appear at most once in a list. Attached
notes and public tag selections are explicit, durable edges rather than ephemeral publish-UI
choices.

Repository transactions enforce these cross-entity invariants:

- a section note targets the same list as its section block;
- an attached place note targets the same `PlaceId` as the block's place;
- a selected tag is actually assigned to the block's place;
- live `(blockId, noteId)` and `(blockId, tagId)` edges are unique.

## Publication state

Public documents and private editing capabilities are not stored on `List` or `Note`. They live in
a separate local entity so public content, local draft state, credentials, retries, and revocation
cannot be confused.

```ts
interface Publication {
  id: string;
  target: { kind: "list" | "note"; id: string };
  mode: "snapshot" | "hosted";
  slug?: string;               // hosted mode; public and guessable
  credentialId?: string;       // points to a private local editor bearer token
  status: "draft" | "queued" | "publishing" | "published" | "failed" | "revoking" | "revoked";
  localRevision: string;
  lastPublishedLocalRevision?: string;
  publishedRevision?: string;  // server revision / ETag
  lastPublishedHash?: string;
  publishedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

Snapshot mode records what was exported but has no server credential. Hosted mode requires a
high-entropy editor bearer token from creation onward. The token is never included in a public URL
or shared document. See [Lists & Sharing](./sharing.md).

## What the UI displays

There is no merge with app-wide user corrections. The current v1 surface uses:

```text
displayed place = Place.lastVerified facts for an OSM-linked place
                  or Place.manual facts with an "unlinked" badge
```

TTL refresh, evidence timestamps, and stale/error badges belong to the deferred freshness surface;
stored evidence is not described as a fresh live observation. Personal notes and guide prose are
separate owned content. Wrong OSM facts lead to the **View on OpenStreetMap** portal, where the
user may inspect/edit/report the source. The app retries search or matching only after upstream
services update. This keeps one public geographic source and avoids introducing a second
moderation-heavy places database.

## Relationships

```text
List ──1:*── ListBlock ──place────▶ PlaceId ──▶ Place
  │             │                       │          │
  │             ├─section──▶ Note       ├─* TagAssignment ─▶ Tag
  │             │                       └─* Note   │
  │             ├─* BlockNoteAttachment ──▶ Note   ├─▶ current OSM ref + evidence
  │             └─* BlockTagSelection ────▶ Tag    └─▶ external refs (imports)
  │
  └──────────────── Publication
```

- Deleting a list tombstones its blocks, attachments, and list-section notes in one local
  transaction. Places whose **only** membership it held are removed with their tags and notes
  (membership is existence); places shared with other lists survive.
- Removing a place takes it out of every list and tombstones its tag assignments, place blocks,
  and private place notes; it never changes OSM.
- Removing or disabling already-published content marks the relevant publication dirty. The old
  public revision remains visible until the revocation/update succeeds.
- Mutating a list name/marker/order, or future guide prose/cover/section, attached place note/media,
  selected tag, or place OSM binding increments every affected publication's `localRevision` and
  queues/coalesces an immutable revision-bearing job in the same transaction.
- Place-link history is preserved as immutable completed intervals when an OSM element is replaced;
  notes and guide membership stay attached to the same `PlaceId`.

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
