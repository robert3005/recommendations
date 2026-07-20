# Sharing — Lists & Posts

Two things publish (2026-07-19, the lists-and-posts pivot): a **list** — the curation itself,
name plus ordered places — and a **[post](./posts.md)** — the editorialised article about a list.
Both share the same machinery and differ only in projection; the word "guide" in dated rulings
below is the pre-pivot name for this published document. Three requirements drive the design:

1. **Private by default** — only explicitly selected content leaves the device.
2. **Durable place context** — each place carries its current OSM link plus bounded copied evidence
   so it still renders and can be re-resolved if that OSM element is replaced.
3. **Persistent named links** — hosted links show the latest successfully published revision
   and the latest OSM data the viewer can successfully resolve.

## One block document, two projections

The versioned block document below serves both public pages:

- A **shared list** projects the list's place blocks (each place's shareable notes may ride
  along) — no narrative sections. Title = list name.
- A **shared post** projects the post's full block sequence — prose sections interleaved with
  place embeds, attached notes, and selected tags — plus a **reference to its list**: the list's
  title always, and the list's public slug when the list itself has a hosted publication, so the
  post page can offer *"From the list: 〈name〉"* as a working link
  ([Posts](./posts.md#publishing)).

One schema, one viewer component, one share service; a list page is simply the degenerate,
sections-free case. Documents published before the pivot (guides) parse as posts whose sections
happen to live on a list — the wire schema is unchanged.

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

The document is compressed into the URL fragment:

```text
https://app.example/l#<base64url(compress(sharedDocument))>
```

- No backend receives the document.
- Membership and prose are immutable at share time.
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

## Shared document schema

The document mirrors ordered blocks (a list's place blocks, or a post's full sequence) while
keeping the owner's private `PlaceId`, database ids, and editor bearer token out of the payload.

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

interface SharedDocument {
  v: 1;
  kind?: "list" | "post";     // absent in pre-pivot documents, which read as posts
  slug?: string;              // hosted mode only
  title: string;
  description?: string;
  list?: { title: string; slug?: string }; // posts: the list this post editorialises
  cover?: { hostedMediaId: string };
  blocks: SharedBlock[];
  contentHash: string;
  publishedAt?: string;
}
```

*(Implementation note: the schema package still calls this type `SharedGuide`; `kind` and `list`
are additive optional fields, so `v: 1` documents remain wire-compatible.)*

A shared **list** contains only place blocks. A shared **post** may interleave sections and
carries `list` — its list's title, plus the list's public slug when the list is itself hosted;
the client drops a slug whose list page was revoked at the next successful publish
([Posts](./posts.md#publishing)).

A live section block includes its own post note only when that note is shareable. A place note is
included only through a live `BlockNoteAttachment`, and a personal tag only through a live
`BlockTagSelection`. `Note.shareable` is a prerequisite, not sufficient publication state.

> **First-release simplifications (2026-07-19, implemented with Phase 4).** Until the guide
> editorial surface ships the attachment/selection UI: a place block carries **every shareable
> note of its place** directly (`shareable` acts as the attachment), and **no tags are shared at
> all** — more private than the eventual explicit `BlockTagSelection` model, never less. The
> schema keeps both fields so documents stay forward-compatible. On import, unresolved OSM
> anchors become **pending items in the interop review queue** (spec/src/interop.md) rather than
> a bespoke pending surface; the snapshot viewer route is `/l` inside the app shell.
Disabling sharing or detaching content queues a new hosted revision; the previous public revision
remains visible until that update succeeds.

The publish preview lists the exact title, prose, tags, copied OSM evidence, and media that will
leave the device. Public pages default to `noindex`; discoverability can be a later explicit option.

## Local publication record

The private [`Publication`](./data-model.md#publication-state) entity tracks the target, slug,
credential reference, local revision, server revision, hash, status, and errors. The editor token
itself lives in private local credential storage and never appears in `SharedDocument`.

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
include tokens only inside an explicitly encrypted secrets bundle; ordinary list/post exports do
not include them.

> **Implementation decisions (2026-07-19, Phase 5).**
>
> - **Edits mark, creators publish.** A local edit on a hosted target commits — in the same
>   IndexedDB transaction as the edit itself — a `queued` publication state and one coalesced
>   *payload-less* outbox job (a dirty marker). Drains never send dirty markers: only an explicit
>   publish action projects the current document, attaches the payload, and sends. The launch-time
>   outbox retry therefore completes interrupted explicit work but never auto-publishes local
>   edits — the public page changes only when the creator acts.
> - **Idempotency-key hygiene.** A retry of the same revision reuses the failed job and its
>   `Idempotency-Key`. Once a job has been *attempted*, its key may have committed server-side, so
>   a newer revision always retires that job and goes out under a fresh key — a key is never
>   reattached to a different payload.
> - **First-publish slug claim.** On a `409` the client first probes whether the slug is already
>   its own from a commit whose acknowledgement was lost (public `GET` for the revision, then a
>   conditional `PUT` with its own token); only when that reclaim is refused does it walk
>   `-2…-9` suffixes. Note documents rewrite their embedded `slug` to each candidate.
> - **Failure isolation and revocation precedence.** Outbox order holds per publication — one
>   failing page never starves another (this includes a missing editor credential). A failed
>   revocation surfaces as `failed` and retries under its original key; an explicit revocation
>   deletes pending publish jobs first so a failed draft can never strand the unpublish.
> - **In-flight edits stay queued.** When an older publish completes while a newer local revision
>   already exists, the publication records the published revision but keeps `queued` status and
>   its dirty marker.
> - **Preflight before first publish.** Creating a hosted link stops for an exact disclosure of
>   the projection (title, places with coordinates, shareable note prose); nothing leaves the
>   device until the creator confirms. The unpublish controls carry the standing honesty note
>   that downloaded copies and third-party caches cannot be remotely erased.
> - **Deletion queues revocation.** Deleting a published list or note (directly or through a
>   place-deletion cascade) marks its publication `revoking` with a durable DELETE job — never an
>   orphaned public page; removing content from guides queues their re-projection the same way.
> - **Revoked means a fresh claim.** Publishing again after revocation creates a new publication
>   and claims a new slug; the tombstone is never updated. A failed revocation retries its
>   pending DELETE job — the Retry control never turns an unpublish into a publish.
> - **Transport.** An absolute non-localhost `http:` share URL blocks all mutations at the
>   client: the Bearer credential never crosses an explicitly insecure transport.
> - **Viewer recovery uses both epochs as one decision.** Recovery searches near each distinct
>   copied coordinate and relinks only when first-seen and last-verified evidence converge on one
>   unique winner; disagreeing winners render as ambiguity. Snapshot generation also enforces the
>   decoder's inflated-size limit, the preview names every omitted image and stable-id key, and
>   the disclosed link size is the final URL's.
> - **Convergence, refined (2026-07-19, late):** a high-confidence winner in one epoch is accepted
>   when the other epoch does not contradict it — it names the same winner, lists it among its
>   plausible candidates, or its own observation is still plausibly the same real-world place.
>   An epoch that actively points elsewhere (moved + renamed) makes the recovery ambiguous. The
>   same rule governs offline local-evidence reuse when importing a shared guide.
> - **Retry knows its meaning first.** A failed publication's Retry control stays disabled until
>   the outbox has answered whether an unpublish is pending — the unknown window can never default
>   to a publish. First-publishing a NOTE page also stops for the exact-prose preflight.
> - **Selection follows resolution.** In the public viewer, selecting an article entry recentres
>   at the live-resolved coordinates when resolution succeeded, never stale copied ones.

## Public viewer

The public route is read-only and needs no account. It reuses the app's pane-and-canvas grammar
([Views](./map-view.md#the-grammar)) with read-only chrome: a shared post renders as an article
in the pane with the canvas following it, plus its *"From the list"* link when one is carried; a
shared list renders as the place sequence on the same shell:

1. Decode the fragment or fetch the current hosted `SharedDocument` revision.
2. Paint sections and place cards immediately from copied evidence or manual facts.
3. Resolve each `kind: "osm"` anchor's `currentOsmRef` through the production resolver. Manual
   anchors are never resolved: they render as labeled unlinked pins with owner-provided facts.
4. On a confirmed missing/incompatible element, attempt a unique high-confidence evidence match.
5. On ambiguity or provider failure, retain the fallback and show its state/timestamp.
6. Render the interleaved article and synchronized map without exposing editing controls.
7. Offer **Add these places to my library** (a shared list imports as a list; a shared post's
   embeds import into a list named after it). Reuse an existing local place where possible;
   create a new one only after the shared ref or a unique high-confidence replacement resolves.
   Unresolved OSM items remain pending previews rather than silently degrading into unlinked
   pins; a shared **manual** anchor imports as a manual place per the
   [deduplication rules](./place-identity.md#import-and-deduplication).

The viewer never modifies the author's document after a temporary match. A confirmed owner-side
relink dirties the hosted publication so the next successful publish carries the repaired OSM
reference.

## Share service

The service is separate from account sync. Reads are public; mutations use a bearer token from the
first hosted release. Three kinds publish under the same protocol — `/s/lists` (implemented;
pre-pivot guide documents live here and keep their slugs), `/s/posts` (the post projection), and
`/s/notes` ([note pages](./notes.md#publishing-a-note-page)); the `/s/lists` contract below is
normative for all three:

```text
POST   /s/lists
       Authorization: Bearer <editor-token>
       Idempotency-Key: <publication-job-id>
       { desiredSlug, document }
       → 201 { slug, revision }

GET    /s/lists/:slug
       → 200 SharedDocument + ETag

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
- Idempotency keys are scoped to `(kind, operation, slug, token)` — a key can neither complete a
  different operation nor replay one slug's result as another's, and never leaks across tokens.
- Update atomicity: the audit entry, a non-replayable key reservation, the conditional document
  write, and the replayable success record commit together, and the write is **guarded inside
  the unit** — a lost revision race (a conditional write that changed nothing) aborts the whole
  unit rather than letting bookkeeping or a replayable success land for a write that did not
  apply. An interrupted update re-executes — it never phantom-replays success.
- Create atomicity mirrors it: the key reservation and audit precede the atomic slug claim, and
  the success record lands last — an interrupted `POST` leaves no public document and the same
  token + key completes the original create on retry.
- Public `GET`/`304` responses carry a stable per-publication `Surrogate-Key` so an update or
  revoke can purge every cached representation deterministically.
- Each create and update commits as ONE transactional storage unit (a D1 batch): audit entry,
  idempotency-key reservation, the document write, and — last, as the commit acknowledgement —
  the replayable success record. An interrupted commit leaves nothing durable and re-executes.
- The batch API is a hard requirement, not an optimization: when the storage binding offers no
  transactional batch, a commit fails closed **before any write** — there is no sequential
  fallback, because ordered individual statements cannot make the bookkeeping and the document
  write stand or fall together.
- An update's acknowledgement (response body and replay record) is its own committed transition —
  `expectedRevision + 1` with the body it wrote. It is never re-read from storage after the
  commit, where a later writer's already-landed revision could masquerade as this update's
  result.
- The schema keeps an append-only `document_revisions` store (trigger-populated) as internal
  version backups. Internal audit entries and version backups are retained for **90 days**, then
  purged (services/share/OPERATIONS.md); they are never publicly addressable.
- `DELETE` counts against the same per-token mutation quota as create and update.
- Every `/s/*` response (not just the preflight) carries the CORS grant for the separately hosted
  web client.
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
explicit public projections; the sync transport (in v1 since 2026-07-19 —
[Storage & Sync](./storage-sync.md#multi-device-sync)) moves private owned entities between the
owner's devices. A sync account may allow editor-token recovery and private readership later, but
public named links and their URL shape do not depend on accounts.
