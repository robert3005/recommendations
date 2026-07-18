# Places, Tags & Lists — Data Model

The model separates two kinds of data:

1. **OSM observations** — source facts that Placemarks copies for display, offline fallback, and
   identity recovery. OSM remains the upstream source of truth.
2. **Owned data** — durable place identities, saves, tags, notes, guides, and publication state.

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
}

interface Place {
  id: PlaceId;
  origin: "osm" | "manual";
  // OSM binding — present from creation when origin is "osm";
  // absent on an unlinked manual place until the owner links one.
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
  manual?: ManualFacts;        // owner-provided facts; required while unlinked
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
lifecycle. `firstSeen` is immutable recovery evidence once set. `lastVerified` is the latest
successful observation and the only durable POI fallback; there is no second `cachedPoi`
authority. See [Durable Place Identity](./place-identity.md) for creation, refresh, conservative
relinking, and deduplication rules.

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

## SavedPlace (personal, owned)

`Place` owns identity and copied OSM evidence. `SavedPlace` represents the user's decision to keep
that place. There is at most one live `SavedPlace` per `PlaceId` in a library.

```ts
interface SavedPlace {
  id: string;
  placeId: PlaceId;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

List membership and tag assignment are separate edge entities below. Reverse relationships are
queries, not duplicated arrays on `SavedPlace`.

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
  savedPlaceId: string;
  tagId: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

The repository enforces one live assignment for each `(savedPlaceId, tagId)` pair. Tag names are
normalized for uniqueness while preserving the user's display casing.

## List (a group of places; opt-in guide)

A list is first an **ordered group of places with a description** — that is the primary flow
(inverted 2026-07-18: lists come first, guides later). The same blocks can additionally
interleave narrative sections, which turns a list into a guide; that enrichment is a later
milestone. Blocks are their own entities so adding, removing, or reordering one item does not
replace a whole array during future sync.

```ts
interface List {
  id: string;
  name: string;
  description?: string;
  coverMediaId?: string;
  color?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

type ListBlockContent =
  | { type: "section"; noteId: string }
  | { type: "place"; savedPlaceId: string };

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
  tagId: string;               // tag assigned to that block's saved place
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
- an attached place note targets the same `PlaceId` as the block's saved place;
- a selected tag is actually assigned to the block's saved place;
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

There is no merge with app-wide user corrections:

```text
displayed POI = latest successfully resolved OSM observation
                or Place.lastVerified with a visible stale/error state
                or Place.manual facts with an "unlinked" badge (manual pins)
```

Personal notes and guide prose are separate owned content. Wrong OSM facts lead to **View/Edit on
OpenStreetMap**, followed by **Check for OSM updates**. This keeps one public geographic source and
avoids introducing a second moderation-heavy places database.

## Relationships

```text
List ──1:*── ListBlock ──place────▶ SavedPlace ──▶ PlaceId ──▶ Place
  │             │                       │                         │
  │             ├─section──▶ Note       ├─* TagAssignment ─▶ Tag │
  │             │                       └─* Note                  │
  │             ├─* BlockNoteAttachment ───────────────▶ Note    │
  │             └─* BlockTagSelection ─────────────────▶ Tag     │
  │                                                               ▼
  └──────────────── Publication                         current OSM ref
                                                               + evidence
```

- Deleting a list tombstones its blocks, attachments, and list-section notes in one local
  transaction. It does not delete saved places.
- Deleting a saved place tombstones its tag assignments, place blocks, and private place notes; it
  never changes OSM.
- Removing or disabling already-published content marks the relevant publication dirty. The old
  public revision remains visible until the revocation/update succeeds.
- Mutating a list title/description/cover, section note, attached place note/media, selected tag,
  block/order, or place OSM binding increments every affected publication's `localRevision` and
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
