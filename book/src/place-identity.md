# Durable Place Identity

OpenStreetMap identifies map **elements**, not permanent real-world places. An element keeps its id
while it exists, but a café represented by `node/123` may later be redrawn as `way/456`, merged into
another feature, deleted and recreated, or repurposed. Placemarks therefore must not use an OSM id
as the durable identity for a user's notes, tags, or guide entries.

## Identity rule

Every place persisted by Placemarks has:

1. An immutable, app-owned `PlaceId`, used by all personal data.
2. A current/last-confirmed OSM binding, which must resolve when the place is first created but may
   later become missing.
3. Append-only history of previously confirmed OSM links.
4. Copied OSM evidence from when the place was first linked and last verified.

The copied evidence is deliberately durable. It provides an offline fallback and enough context to
find the same real-world place if its OSM element id changes. It is not a user-authored correction
layer and is never written back to OSM automatically.

```ts
type PlaceId = string; // UUID; immutable across relinks, backup restore and sync
type OsmElementType = "node" | "way" | "relation";

interface OsmElementRef {
  type: OsmElementType;
  id: string;                 // OSM ids are serialized as decimal strings
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

interface OsmLinkHistoryEntry {
  ref: OsmElementRef;
  linkedAt: string;
  unlinkedAt?: string;
  reason?: "replaced" | "merged" | "owner-confirmed" | "resolver-match";
}

interface Place {
  id: PlaceId;
  origin: "osm" | "manual";
  currentOsmRef?: OsmElementRef;      // absent on an unlinked manual place
  currentOsmLinkedAt?: string;
  osmRefHistory: OsmLinkHistoryEntry[];
  firstSeen?: OsmEvidence;    // immutable recovery evidence, set when first OSM-linked
  lastVerified?: OsmEvidence; // last successfully resolved observation
  manual?: { name: string; lat: number; lng: number; category?: string };
  resolutionState: "resolved" | "stale" | "unavailable" | "missing" | "needs-review" | "unlinked";
  lastResolutionAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
```

Invariants: an `origin: "osm"` place has a binding and `firstSeen` from creation and is never
`unlinked`; an `origin: "manual"` place starts `unlinked` with `manual` facts and enters the
normal lifecycle when linked. `origin` is provenance and never changes.

`identityTags` is a bounded subset useful for matching, not an unfiltered copy of OSM. It may
include names and brand, the primary category tag, relevant `addr:*` fields, `website`, `phone`,
`wikidata`, `brand:wikidata`, and useful `ref:*` values. Strong external identifiers are evidence,
not guaranteed truth.

`firstSeen` is never overwritten. `lastVerified` changes only after a successful, plausible
resolution. Keeping both prevents a bad or repurposed upstream element from destroying all of the
evidence needed to recover the original place.

## Creating and saving a place

The preferred path creates a place from an existing OSM POI (backup restore is the separate
trusted recovery path):

1. Search or map selection produces an OSM candidate.
2. The resolver fetches that exact element and creates an `OsmEvidence` observation.
3. A `Place` and its `SavedPlace` are committed atomically, reusing an existing `Place` when the
   current or historical OSM reference is already known.
4. Notes, tags, and list blocks refer to `PlaceId`, never directly to the OSM element.

A long press opens a nearby-OSM candidate picker first. If the place is absent, the user has two
explicit choices:

- **Add it on OpenStreetMap** — open the OSM editor at that location, add it upstream, then return
  and retry the match after OSM-derived services have caught up. Preferred for real public POIs,
  because it improves the shared map.
- **Save as an unlinked pin** — create an `origin: "manual"` place from the owner's name, the
  chosen coordinates, and an optional category. It works offline, is clearly labeled as not linked
  to OpenStreetMap, and is the right home for spots that don't belong in OSM at all (a picnic
  bench, a meeting point, a friend's doorstep).

## Unlinked manual places

A manual place skips resolution entirely: `resolutionState` stays `unlinked`, the UI displays its
`manual` facts labeled as owner-provided, and no refresh is scheduled. **Link to OpenStreetMap**
reruns the candidate picker at any time; a confirmed selection sets the binding and evidence and
moves the place into the normal lifecycle (its `manual` facts are retained as provenance and
fallback). Manual facts are personal data — they are never sent to OSM and carry no OSM
attribution.

## Refresh and re-resolution

Resolution is conservative because attaching a person's notes to the wrong business is worse than
showing stale data.

### 1. Resolve the current reference first

Fetch `currentOsmRef` directly. If it succeeds and its location/name/category remain plausibly the
same place, update `lastVerified`, the OSM version, and `resolutionState = "resolved"`. Ordinary
changes to name, website, hours, phone, or address do not create a new identity.

A radical move combined with incompatible identity fields is treated as possible element
repurposing and becomes `needs-review`; it is not accepted silently.

### 2. Distinguish unavailability from disappearance

Timeouts, offline state, rate limits, and provider errors set `unavailable` and retain the existing
binding. They are never evidence that the OSM element disappeared. A TTL expiry without a completed
refresh is `stale`.

Only a definitive missing/deleted result, or a successfully fetched but clearly repurposed element,
starts recovery.

### 3. Search using durable evidence

The resolver searches near both first-seen and last-verified coordinates. Candidates are scored in
roughly this order:

1. Matching stable external ids such as `wikidata`, brand ids, or domain-specific `ref:*` tags.
2. Website domain and normalized phone.
3. Normalized name/brand plus address.
4. Compatible category and distance.

Distance alone can never establish identity. A replacement may be a node, way, or relation.

### 4. Relink conservatively

- One unique, high-confidence candidate may be relinked automatically.
- Ambiguous candidates set `needs-review` and ask the owner to choose.
- No plausible candidate sets `missing` and continues to display `lastVerified` as explicitly stale.
- A confirmed relink appends one immutable completed interval to `osmRefHistory`, using
  `currentOsmLinkedAt` as its start, then sets the new current reference/link time. It never rewrites
  an existing history entry.

After a relink, named publications are marked dirty and republished through the normal publication
outbox. An old snapshot link still has its copied evidence and can attempt the same high-confidence
recovery for display.

## Display semantics

The place card displays:

```text
latest successfully resolved OSM observation
    otherwise lastVerified, with its timestamp and state
```

The UI never presents copied evidence as live data. `stale`, `unavailable`, `missing`, and
`needs-review` are visible states with retry and review actions.

Public viewers may use copied evidence for a temporary high-confidence match, but they do not
mutate the author's published document. If resolution is ambiguous, they show the fallback with an
"OSM record unavailable" notice.

## Correcting or adding OSM data

Placemarks does not maintain a global POI correction database. For an existing element, **View on
OpenStreetMap** opens `https://www.openstreetmap.org/<type>/<id>`, where the user can inspect its
history and choose Edit. **Edit on OpenStreetMap** opens the OSM editor focused on the place. For a
missing POI, the editor opens at the chosen coordinates.

After the user returns, **Check for OSM updates** re-runs exact resolution or matching. OSM updates
and downstream indexes are asynchronous, so the app keeps the last verified evidence until the new
or changed element becomes available.

Personal notes and guide prose are never sent to OSM. Any future direct editing integration would
require explicit user confirmation, OSM authentication, appropriate tagging, and an attributable
changeset comment; it is outside v1.

## Import and deduplication

Backup restore and public-guide import have different identity semantics:

- Restoring a validated backup preserves its `PlaceId`; that id belongs to the restored library.
- A public guide deliberately contains no author's `PlaceId`. The receiving library reuses an
  existing place or mints a local id only after the shared current reference or a unique
  high-confidence replacement resolves successfully.
- If a shared place cannot resolve, it remains a pending import with copied preview evidence. It is
  not persisted as a new saved place until resolution succeeds; an already-local matching place may
  still be reused in its existing state.

For any save/import candidate, match in this order:

1. The same app `PlaceId` within the same library.
2. An exact current or historical OSM reference.
3. A unique, high-confidence evidence match.
4. Owner confirmation for every ambiguous match.

An imported **manual** anchor never evidence-matches against OSM-linked places automatically: it
reuses an existing manual place only on a near-exact name+coordinate match, otherwise it imports
as a new unlinked pin (the importer may link it later).

Library-to-library transfer uses the versioned backup/import protocol, not the public guide schema.
A merge validates ids and OSM evidence and resolves collisions explicitly; it never assumes an
arbitrary UUID from an untrusted document is global authority.
