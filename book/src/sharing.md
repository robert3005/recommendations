# Lists & Sharing

Lists are the app's unit of curation. A
[named list](./data-model.md#list-a-named-group-of-places) becomes a guide when the later editorial
layer adds narrative sections, selected notes, and a reading experience; that guide is the unit
published for sharing. Three requirements drive the design:

1. **Private by default** — only explicitly selected guide content leaves the device.
2. **Durable place context** — each place carries its current OSM link plus bounded copied evidence
   so it still renders and can be re-resolved if that OSM element is replaced.
3. **Persistent named links** — hosted links show the latest successfully published guide revision
   and the latest OSM data the viewer can successfully resolve.

“Latest successfully published” is deliberate. A local edit made offline, or a failed publish,
cannot change an already-public document. The owner UI always distinguishes local draft, queued,
failed, and published state.

## Share source links plus recovery evidence

A shared place does not use an OSM element id as permanent identity. An OSM-linked place carries:

- the current node/way/relation reference;
- a bounded first-seen and last-verified OSM observation;
- a stable block id within that publication.

An unlinked manual pin shares only its owner-provided name, coordinates, and optional category,
explicitly marked as carrying no OSM claim.

The viewer first resolves the exact OSM reference. If OSM confirms that it is gone or incompatible,
the viewer may use the copied evidence for the conservative matching process from
[Durable Place Identity](./place-identity.md#refresh-and-re-resolution). Provider failure is not a
missing element and never causes relinking.

Copied evidence is also the immediate and offline fallback. It is labeled with its observation time
and never presented as current when live resolution fails.

## Two sharing modes

Both modes use the same versioned document schema and viewer component, but their URLs and update
semantics differ.

### Mode A — Snapshot link

The guide document is compressed into the URL fragment:

```text
https://app.example/l#<base64url(compress(sharedGuide))>
```

- No backend receives the document.
- Guide membership and prose are immutable at share time.
- OSM facts may still refresh or recover through the resolver.
- Copied evidence keeps the page useful when offline or when an OSM element disappeared.
- Images are omitted. A no-backend snapshot cannot hold a durable media lease; the share preview
  explains the text placeholders before generation.

Snapshot generation enforces explicit compressed and inflated byte limits. The decoder validates
the schema, caps decompression work, and rejects oversized documents. The UI shows the final URL
size before copy/share and never silently truncates notes or places.

“No backend receives the document” describes HTTP fragment handling, not secrecy from the local
browser. The full fragment is visible to the viewer's JavaScript, browser history/sync, extensions,
screenshots, and anyone receiving the copied link. Analytics, error reporting, and logs must redact
fragment-bearing URLs.

### Mode B — Hosted named link

The share service stores the current published document under a public, human-readable slug:

```text
https://app.example/l/lisbon-trip
```

- Anyone can read or guess the public slug; it is not a secret or read-access token.
- Before creation, the client generates and durably stores a high-entropy **editor bearer token**,
  then sends it with the idempotent create request.
- Updating and revoking require that bearer token; reading never does.
- The public URL shows the last successfully published revision, not unuploaded local edits.
- A slug remains reserved after revocation so an old link can never be reassigned to another owner.

No account is required. Bearer-token authorization solves write ownership without introducing user
profiles or exposing an editing secret in the share URL.

## Shared guide document

The document mirrors ordered list blocks while keeping the owner's private `PlaceId`, database ids,
and editor bearer token out of the payload.

```ts
interface SharedPlaceEvidence {
  osmRef: OsmElementRef;       // ref from which this evidence was observed
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
  stableIds?: Record<string, string>; // bounded wikidata/brand/ref identifiers
  observedAt: string;
}

type SharedPlaceAnchor =
  | {
      kind: "osm";
      currentOsmRef: OsmElementRef;
      firstSeen: SharedPlaceEvidence;
      lastVerified: SharedPlaceEvidence;
    }
  | {
      kind: "manual";              // an unlinked pin: owner-provided facts, no OSM claim
      name: string;
      lat: number;
      lng: number;
      category?: string;
    };

interface SharedNoteBody {
  pageSlug?: string;
  title?: string;
  body: string;
  media?: Array<{ hostedMediaId: string }>;
}

type SharedBlock =
  | {
      id: string;
      type: "section";
      note: SharedNoteBody;
    }
  | {
      id: string;
      type: "place";
      place: SharedPlaceAnchor;
      notes?: SharedNoteBody[];
      tags?: string[];         // only explicit BlockTagSelection values
    };

interface SharedGuide {
  v: 1;
  slug?: string;              // hosted mode only
  title: string;
  description?: string;
  cover?: { hostedMediaId: string };
  blocks: SharedBlock[];
  contentHash: string;
  publishedAt?: string;
}
```

A live section block includes its own list note only when that note is shareable. A place note is
included only through a live `BlockNoteAttachment`, and a personal tag only through a live
`BlockTagSelection`. `Note.shareable` is a prerequisite, not sufficient publication state.
Disabling sharing or detaching content queues a new hosted revision; the previous public revision
remains visible until that update succeeds.

The publish preview lists the exact title, prose, tags, copied OSM evidence, and media that will
leave the device. Public pages default to `noindex`; discoverability can be a later explicit option.

## Local publication record

The private [`Publication`](./data-model.md#publication-state) entity tracks the target, slug,
credential reference, local revision, server revision, hash, status, and errors. The editor token
itself lives in private local credential storage and never appears in `SharedGuide`.

Publication follows a durable state machine:

```text
local edit → queued → publishing → published
                              └──→ failed → queued on retry

unpublish → revoking → revoked
                    └→ failed → revoking on retry
```

Closing the tab, losing the network, or retrying a request must not roll the public document back.
Each immutable outbox job records the local revision it projects. Idempotency keys and conditional
server revisions prevent rollback; completing an older job never clears a newer pending revision.
The UI derives “changes pending” from
`localRevision !== lastPublishedLocalRevision`, not from one transient request status.

Losing the only device-held editor token makes the hosted page uneditable. Recovery exports may
include tokens only inside an explicitly encrypted secrets bundle; ordinary guide exports do
not include them.

## Public guide viewer

The public route is read-only and needs no account:

1. Decode the fragment or fetch the current hosted `SharedGuide` revision.
2. Paint sections and place cards immediately from copied evidence or manual facts.
3. Resolve each `kind: "osm"` anchor's `currentOsmRef` through the production resolver. Manual
   anchors are never resolved: they render as labeled unlinked pins with owner-provided facts.
4. On a confirmed missing/incompatible element, attempt a unique high-confidence evidence match.
5. On ambiguity or provider failure, retain the fallback and show its state/timestamp.
6. Render the interleaved article and synchronized map without exposing editing controls.
7. Offer **Add this guide to my library**. Reuse an existing local place where possible; create a
   new one only after the shared ref or a unique high-confidence replacement resolves. Unresolved
   OSM items remain pending previews rather than silently degrading into unlinked pins; a shared
   **manual** anchor imports as a manual place per the
   [deduplication rules](./place-identity.md#import-and-deduplication).

The viewer never modifies the author's document after a temporary match. A confirmed owner-side
relink dirties the hosted publication so the next successful publish carries the repaired OSM
reference.

## Share service

The service is separate from account sync. Reads are public; mutations use a bearer token from the
first hosted release.

```text
POST   /s/lists
       Authorization: Bearer <editor-token>
       Idempotency-Key: <publication-job-id>
       { desiredSlug, document }
       → 201 { slug, revision }

GET    /s/lists/:slug
       → 200 SharedGuide + ETag

PUT    /s/lists/:slug
       Authorization: Bearer <editor-token>
       If-Match: <revision>
       Idempotency-Key: <publication-job-id>
       { document }
       → 200 { revision }

DELETE /s/lists/:slug
       Authorization: Bearer <editor-token>
       If-Match: <revision>
       Idempotency-Key: <publication-job-id>
       → 204
```

- The client generates at least 256 random bits with a cryptographic RNG and persists the token
  before enqueueing `POST`; retry reuses the same token and idempotency key.
- Only a hash of the editor token is stored server-side. TLS is mandatory; token comparison is
  constant-time; tokens and authorization headers are redacted from logs, traces, and errors.
- Mutation and creation responses use `Cache-Control: no-store`.
- `POST` claims a slug atomically and returns `409` on collision.
- `If-Match` prevents stale clients from overwriting a newer revision.
- Documents are schema-validated and subject to request, document, note, and media limits.
- Slugs are normalized; reserved names are rejected. Creation has stricter quotas/challenges than
  reading, plus abuse reporting/takedown and per-publication media budgets.
- Mutations and reads are rate-limited and audited; revoked slugs retain a non-readable tombstone.
- Replaying an already-completed `DELETE` with the same idempotency key returns success.
- The chosen deployment uses transactional D1/SQL for atomic slug claims and conditional revision
  updates; another consistent SQL/document store may sit behind the same contract. No PostGIS is
  required.

Public `GET` responses use bounded cache lifetimes and purgeable surrogate keys. On update, old
revisions become non-public; on revoke, document and media CDN entries are purged within the stated
service window. Internal audit/version backups have a documented retention period and are never
publicly addressable. The UI explains that already-downloaded copies and third-party caches cannot
be remotely erased.

## Relationship to sync

Publishing and multi-device sync solve different problems. The publication outbox sends only
explicit public projections; a future sync transport moves private owned entities. Adding accounts
may allow editor-token recovery and private readership later, but public named links and their URL
shape do not depend on accounts.
