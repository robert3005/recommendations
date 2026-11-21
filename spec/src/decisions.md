# Decisions

**Non-normative.** This is the record of *how the design changed and why*. Every
chapter in this book describes only the current design — if a chapter and this log
disagree, the chapter is right and this entry is history.

That division is itself the most important decision here. Before 2026-07-26 each
ruling was appended to the chapter it changed, and the design it replaced was left
standing in the prose. `map-view.md` carried three home-screen designs at once,
the retired word *guide* still named a wire type, and the "deferred" freshness
surface had a fully built six-state machine underneath it. An append-only spec
produces a union-of-all-designs codebase: roughly 8,500 lines of it, removed over
2026-07-26.

**The rule from here: a ruling that supersedes prose must delete that prose.**

---

## 2026-11-21 — the review harvest

The product now classifies what reviewers say about a place, which needs far more review text
than any file export or official API provides. The Places API returns only a few reviews per
place, may cache only place IDs long term, and forbids showing its content beside a non-Google
map. **A local harvester** therefore downloads Google Maps place facts and reviews to the owner's
machine, starting with the self-hosted gosom scraper and with a paid scraping API as the planned
fallback ([Review Harvest](./harvest.md)). This reverses "no Google API calls, ever" and "no
scraping" for that tool only: the web app still calls nothing proprietary, and review text is
classification input, never displayed or published. The terms-of-service risk was accepted
explicitly for a private dataset.

## 2026-07-26 — richer place metadata

The owner asked for the place card to show a picture, a description, and more POI facts —
and for raw coordinates to leave the card. Places (and their published projections) gain
optional `website`, `phone`, `openingHours`, `cuisine`, `wheelchair`, `description`, and
`wikipediaUrl`, captured opportunistically: the exact OSM lookup maps the element's tags, and
a Wikipedia REST summary is consulted only when the element names an article, filling the
description (credited via `wikipediaUrl`) and the photo fallback. The wikimedia-only image
rule stands — Wikipedia thumbnails are accepted only from Wikimedia hosts. Facts fill only
while missing: enrichment never overwrites anything the user can see, and it stays
best-effort and silent, one attempt per place per session.

## 2026-07-26 — search-first chrome

The persistent Lists/Review/Settings nav is retired; search owns the top bar. The notebook
header is now a small home affordance (the wordmark, back to `/`), the add-a-place field
filling the remaining width, and the pane step buttons. Settings moved behind a small floating
gear chip pinned bottom-left of the shell. Review is exposed only while an import batch is
reviewing — a pill in the top bar carrying the review-queue count; `/review` stays
deep-linkable. The list page's posts sidebar is demoted to a quiet alternate view behind a
deliberately unaccented Places/Posts toggle, and the home rows drop their posts indicator —
marker, name, count only (supersedes the sidebar reading of requirement 7 — owner's call).

## 2026-11-21 — Paper and Night replace the deep-green console

The owner asked for a modern look in the spirit of spiraldb.com and typesafe.ai and picked, from
mockups, a light default with a dark companion plus a few playful touches. The deep-green console
and "instrument-panel retrofuturism" are retired. Paper (`#FCFCF9` ground, `#171716` ink,
`#DFDFDD` hairlines) is the default; Night (charcoal `#171716` ground) follows
`prefers-color-scheme: dark`. Token names carried over, so most components changed no colour
classes; new tokens are `--color-wash`, `--color-signal`, `--color-tag*`, `--color-blush`,
`--color-hover`, `--radius-pill`, `--shadow-lift`, and `--font-pixel`. From Spiral: off-white
ground, hairlines, a grotesk display face over a plain text sans, crisp surfaces with pill
controls, one soft shadow. From typesafe: black pixel-face section labels and dish tags with
pink lettering, pink meter fills, a pink hover fill, large tight headlines. Type is self-hosted
(Schibsted Grotesk, Inter, Geist Mono, VT323) so the offline shell and CSP need no font host.
The basemap plate is to be restyled to follow these tokens, including a dark plate for Night.

## 2026-07-26 — the deep-green console

The owner picked the design-review artifact's deep green over the near-white paper as the app's
one theme. The chrome tokens inverted in place — paper `#0E1613`, ink `#E9EFE9`, hairline
`#2A3A31`, plus one raised surface `--color-panel` `#15201B` — under the same token names, so
components changed no classes. The eight accent fills are unchanged; the `-deep` text variants
are lightened to stay readable on the dark ground. The basemap deliberately stays the light
plate — a dark console around a lit chart — so controls floating over the map restyled to deep
chips. A light theme replaces dark mode as the listed future.

## 2026-07-26 — POI search adapter

The Photon public demo geocodes streets and towns but is unsuitable for venue search — the
add-a-place field's whole job. A Pelias-class adapter (the API Stadia Maps, Geoapify,
geocode.earth, and self-hosted Pelias all serve) now sits behind the same Geocoder contract,
selected by `VITE_GEOCODER`; its non-OSM-sourced candidates carry no `osmRef` and are treated
like manual placement. Photon stays the keyless dev default; proprietary places APIs remain
banned.

## 2026-07-26 — the refocus (second pass)

Same day, second pass. The morning pass deleted what no decision had ever removed; this one
re-derives scope. The owner restated the product as nine requirements plus one directive —
local editing first, remote state exists to facilitate sharing and nothing else, no syncing
mechanism, the user explicitly publishes updates. **The nine requirements are now the scope
test: anything not in service of them left the spec.** Each item below is a deletion unless
stated otherwise.

- **Multi-device sync and accounts are gone** — transport, mutation outbox, HLC ordering,
  tombstone retention, conflict copies, sync status surface, the Postgres service, auth of any
  kind. Remote state is published documents, full stop. Two devices are two libraries; the
  library archive moves one to the other.
- **Sync-shaped rationales lapsed with the mechanism.** The morning pass kept prose off blocks
  because a losing Markdown body needed a note-shaped conflict copy to live in, and kept
  `resolutionState` because `needs-review` recorded a cross-device relink conflict. No peers,
  no conflicts: both objections are void, and both features go with them.
- **Posts absorbed notes.** `Note`, `PostBlock` and `BlockNoteAttachment` are gone; a post is
  one Markdown body targeting exactly one list or one place. "Place notes" become place posts
  — the same writing, one entity instead of three.
- **Tags** (`Tag`, `TagAssignment`) — not in the nine points. The argument that kept the edge
  (concurrent tag adds must converge) was a sync argument, and lapsed with it.
- **Media** — posts are text plus places in v1; images in posts are a listed future.
- **Snapshot (URL-fragment) links** — one sharing mode remains: the hosted named link.
- **The freshness/re-resolution machinery** — all six states, evidence epochs, TTL refresh,
  relink scoring, `pastOsmRefs`, stale and review badges. A place stores its facts flat; they
  change when the user edits them or re-imports.
- **The versioned ZIP backup protocol** (manifest, checksums, media entries, merge validators)
  — replaced by the **library archive**: one id-preserving JSON file of the whole library, so
  `place:`/`post:` links and post targets survive restore. Editor tokens are excluded unless
  the user opts in at export; a restore without credentials sees its publications but cannot
  update or revoke them.
- **Viewer-side OSM resolution and import-from-a-shared-page** — a published page renders
  exactly what was published, as of publish time.
- **Nearby discovery in any form** — including the explicit "Show nearby places" the morning
  pass had kept, the long-press candidate picker, the category taxonomy and Overpass. (The
  import-review candidate picker survives — it serves the ladder, not discovery.) Not in the nine
  points, and the only thing giving the canvas a standing network appetite.
- **Standalone manual pins.** Manual placement survives only inside import review, where a
  coordinate-less Takeout row can be placed by clicking the map.
- **Takeout-shaped CSV export** and **dark mode** — v1 is light-only; dark is a listed future.
- **The desktop expanded width** (canvas fully hidden), and with it the hidden-canvas idle
  contract that existed only to serve it. Desktop has two notebook widths: split and collapsed.
- **The share protocol collapsed to Bearer `PUT`/`GET`/`DELETE`.** The editor token never
  leaves the device, so each publication has a single writer by construction; `If-Match`, the
  idempotency replay table and `publicationJobs` protected races that cannot occur, and went
  with the outbox. Publish is a foreground action: press the button, watch it succeed or fail,
  press again to retry.
- **Editor tokens moved onto the `Publication` row** — one per publication, device-held,
  hashed server-side, never in a URL. Token loss means republish under a new slug; a stale
  page goes through the takedown contact.
- **Deleting a published list or post now refuses until it is unpublished** — the third
  teardown refusal; no public page is ever orphaned by a local delete.
- **KML import narrowed to Google My Maps** — still requirement 1's "import from Google Maps".
  Standalone GPX/GeoJSON import is cut; GPX stays on the export side only.
- **The OSM-Carto palette ruling is superseded** by [Visual Design](./design.md):
  instrument-panel retrofuturism — warm paper, near-black ink, eight bright accents shared
  with the list markers. Requirement 8 asks for bright accents and clean lines; a land-cover
  palette answered a question nobody had asked.
- **Reaffirmed**: membership-is-existence (an unlisted place has no marker to wear — still
  load-bearing for the visual system) and bottom-up teardown (refusal, never cascade).

---

## 2026-07-26 — the simplification pass

The product thinking survived intact. What went was the scaffolding of three
pivots that no decision had ever removed. Each item below is a deletion unless
stated otherwise.

### Stop being backward-compatible with ourselves

Nothing has ever shipped — no git tags, `version: "0.0.0"`, and the share service
still carrying `database_id = "REPLACE_WITH_REAL_ID"`. Yet the code maintained
eight Dexie schema versions, a 286-line pivot migration, two backup archive
formats, three D1 migrations and legacy route redirects, all protecting databases
that only ever existed on one laptop. Collapsed to one schema version, one archive
format, one migration. Migrations that upgrade a live database start being written
the day one exists.

### Publishing

- **`Publication.mode`** had two cases and only one was ever written. Snapshot
  links remain — they are recordless, and Phase 4's done-when.
- **Standalone note pages** (`/n/:slug`, `/s/notes`) are gone. The spec had
  already disowned them; they were also the only publication kind whose document
  embedded its own slug, which cost the service two special cases and the client a
  slug rewrite inside its collision walk. Publishing one note is now
  new-post-then-publish, which produces a strictly richer page.
- **The dirty-marker mechanism** is gone. `dirtyPublicationsFor` wrote a publish
  job on ~30 write paths, putting the outbox inside ~25 transaction scopes — and
  the drain skipped every one of them (`"A payload-less job is a passive dirty
  marker"`). "Changes pending" was already a projection-hash comparison, which is
  now the only mechanism. Three revision fields collapse to one
  `lastPublishedHash`.
- **The publication outbox** was never a queue. It becomes `publicationJobs`
  keyed by publication with `publish?`/`revoke?` slots, so revoke-beats-publish
  precedence is structural rather than a scan.
- **The share service's `audit` and `document_revisions` tables** are gone, with
  both triggers. Nothing read either, and auditing every public read turned a
  CDN-cacheable page into a database write per view.
- **The commit unit** is gone: create is one INSERT, update one conditional
  UPDATE, and the replay handle is written after the mutation it acknowledges.
  This replaces a batched sequence that forced a lost race to abort by
  deliberately violating a NOT NULL constraint.

  It also weakens a written guarantee, honestly: an interrupted write can leave
  the handle unwritten. The recovery the design already relied on is now ungated —
  a stale `If-Match` whose stored document is byte-identical to the request, owned
  by the requesting token, at exactly the revision this write would have produced,
  is acknowledged. A tombstone under our own token likewise proves a revoke
  applied. Both previously also required a key reservation, which proved nothing
  the content does. `sharing.md`'s "the batch API is a hard requirement" is
  retired.

### The graph

- **`BlockTagSelection`** is gone: an entity, store, synced table, backup section
  and validator, two repair passes and a cascade, all serving per-embed tag
  curation. Published posts no longer carry tags; the wire field stays.
  `Tag`/`TagAssignment` are untouched — that edge is what makes concurrent tag
  adds converge.
- **A note's target is immutable.** No UI ever retargeted one, and supporting it
  cost `updateNote` a third of its body.
- **`Place.osmRefHistory`** becomes `pastOsmRefs: OsmElementRef[]` — a set, not a
  log. Its only readers are a dedup key set and export attribution, neither of
  which reads *when* or *why* a link ended. That recording cost a ~75-line
  append-only-prefix guard, a composite sync merge key, an interval-aware backup
  merge and a schema refinement. `resolutionState` stays and stays durable:
  `needs-review` records a cross-device relink conflict no recomputation can
  reproduce. `lastResolutionAttemptAt` goes.
- **Teardown blockers** collapse from four arrays plus an empty-constructor and a
  has-any predicate to one `Blocker[]`, and from two collectors to one
  `blockersFor(placeId, scope)`. **Bottom-up teardown itself is unchanged** — every
  refusal survives — but the dialog now offers one confirmed *"Delete these N
  notes"*, because the guarantee was that the owner decides, not that they click
  once per note.
- **Sync repair runs one pass per rule.** The sweeps are ordered so no pass
  repeats, and a raced embed writes a *fresh* membership rather than resurrecting
  a tombstone that flaps against peers still holding it.

### The views

- **The canvas quiesce machinery** is gone: `_frameRequest`,
  `_renderTaskQueue`, `style.tileManagers`, `_inViewTiles`, `abortTile` and a
  replaced `triggerRepaint`, all reaching into MapLibre privates against a caret
  dependency. What keeps a hidden canvas cheap is deferred style activation plus
  the `if (idle) return` guards on the projection effects. "Deferred and coalesced
  projections" needs no buffer: if nothing applies while hidden, only the last
  projection can ever apply.
- **Ambient POI discovery becomes an explicit "Show nearby places"** — off by
  default, one bounded fetch, cleared on pan. The category taxonomy and chips are
  gone. This is a real loss for the "local keeping a living map" reader, and the
  most contested call in the pass; it is taken because ambient discovery is the
  pre-pivot front door `vision.md` rejects, and it was the only thing giving the
  canvas a standing network appetite.
- **The URL viewport camera** is gone. It duplicated the persisted last viewport
  and forced a hand-ranked three-way arbitration. Deep-linking `/` at an exact
  camera goes with it.
- **The hand-rolled sheet drag** becomes a tap stepping one detent — which is also
  keyboard operable, which the drag never was.
- **`Map unavailable`** is a top-anchored banner, not a full-bleed overlay: a
  failed tile or glyph can happen over a map that is otherwise drawn and usable.

### The look

The palette comes from OSM Carto's own land cover — leaf, water, amber on map
paper, forest ink instead of black — because the app renders OSM. Expressed as
Tailwind `@theme` tokens; the eight list-marker colours follow. Bright accents
are for fills and large type, with deepened variants for small text.

### Fixed on the way

Four defects, each found by reading the code rather than by a failing test:

1. **Publishing a post shipped an article with no article.** `addPostSection`
   wrote `shareable: false` on every section note and `projectPost` skipped
   non-shareable sections. The unit of privacy is now the post: a section travels
   because the post travels. Covered by `post-prose-projection.test.ts`.
2. **One failed tile blacked out a working map.** The overlay was raised from
   MapLibre's generic `error` event.
3. **Synced images were broken by construction.** `mediaAssets` was in
   `SYNCED_TABLE_NAMES` while `mediaBlobs` was not, so device B received asset
   rows pointing at bytes that did not exist. Media is device-local.
4. **The app offered a recovery path that did not exist** — "restore it from an
   encrypted backup", for a bundle nothing produces. It now says the page can
   only be updated from the device that published it, which is the design.

And one divergence the new `ShareStorage` contract suite found immediately:
`MemoryStorage` overwrote replay handles where D1 uses `INSERT OR IGNORE`. The
memory adapter now matches.

### Proposed and withdrawn

Recorded because each looks obviously right until you read the code:

- **Making places first-class with an "Unfiled" bucket.** Re-adds the entity the
  2026-07-18 ruling deleted, needs a migration reversing Dexie v4 — and an
  unlisted place has *no marker*, so there is nothing to draw on the canvas.
  Membership-is-existence is load-bearing for the visual system, not just the
  model.
- **Cascade-plus-Trash instead of refusals.** Breaks `vision.md` verbatim and
  needs a per-deletion id on every synced row. The actual pain — click-by-click
  dismantling — is fixed by the bulk note delete instead.
- **`Place.tags: string[]`.** `storage-sync.md` names tag assignments first among
  the edges that must merge independently; LWW would drop a concurrent tag.
- **Post prose inline on `PostBlock`.** The conflict copy is note-shaped:
  `mergeRemoteChange` preserves both bodies only for `notes` rows. Inline prose
  leaves a losing Markdown body nowhere to live.
- **Merging the two backends.** The duplication was ~40 lines of helpers, now
  `packages/service-kit`. The runtimes genuinely differ.
- **Dropping `resolutionState`**, and **demoting `Post.listId` to a backlink** —
  after the pivot that invariant *is* the definition of a post.

---

## 2026-07-19 (late) — pane and canvas; bottom-up teardown

Almost every screen is the same scene: content about places beside a map showing
them. So the map stopped being a page. The app became a **content pane** beside a
**single persistent canvas** — see [Views](./map-view.md).

Deletion became refusal rather than cascade: nothing authored dies as a side
effect, and the owner dismantles dependents explicitly. This superseded the
same-day embed-tombstone and detached-post rulings.

## 2026-07-19 — the lists-and-posts pivot

The editorial layer detached from `List` into a standalone `Post`. A list is
working curation whose membership keeps changing; an editorial piece is a document
*about* places, written and published on its own schedule. **Lists curate, posts
editorialise.** Multi-device sync moved into v1 the same day.

The word **guide** was retired here. It survived in prose and in a wire type until
2026-07-26; the wire schema is unchanged, so no public link ever broke.

## 2026-07-18 — the interop pivot

OSM search quality trails Google's in many regions, so finding every place again
through our own map cannot be the front door. **Import from the tools people
actually use** — see [Import & Export](./interop.md). Same day: descriptions left
`List`, standalone saves were removed in favour of membership-is-existence, and
list Edit mode returned because imported lists are too large to curate from place
cards alone.
