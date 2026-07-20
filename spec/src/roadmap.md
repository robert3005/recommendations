# Roadmap

Each phase ends with a usable, testable increment. V1 spans **Phases 0–8** (extended 2026-07-19)
because the product thesis includes **interop with the tools people already use** (2026-07-18:
import is the front door — see [Import & Export](./interop.md)), the **lists-first shell with
posts as the editorial layer** (2026-07-19 pivot — see [Posts](./posts.md)), a persistent
read-only link that its creator can update safely, and **multi-device sync**. Phases 2–5 below
were specified and implemented before the pivot; where they say "guide" they describe what is now
a published list or post, and Phases 6–7 carry the pivot's migration.

## Current implementation audit (2026-07-20; supersedes 2026-07-18)

- **Phase 0 — complete.** The 2026-07-18 leftovers have landed: the full provider contract set
  exists (`MapStyleProvider` and `SharePublisher` in `packages/domain/src/providers.ts` with
  wired adapters, `SyncTransport` in `packages/domain/src/sync.ts`), Storybook stories run
  continuous axe checks (serious/critical violations fail the suite), production provider
  configuration fails closed at build time (malformed URLs and demo hosts included), the
  two-second budget has a repeatable throttled acceptance check against the production build
  (`e2e/performance-budget.offline.spec.ts`: 4× CPU + emulated 4G), and the basemap failure
  state is designed and recovery-gated.
- **Phase 1 — complete on the development/test path.** Production readiness is a provider
  selection/contracting task, not a code gap.
- **Phase 2 — complete.** The 2026-07-18 leftovers were closed by the hardening waves: local
  `asset:` images render, pre-membership libraries migrate losslessly (Dexie v4),
  coordinate/id/size/graph validation guards backup writes, binary media is checksummed,
  export fails closed on unreadable media, backup merge is identity-aware and never forks one
  exact OSM reference into two `PlaceId`s, cleared optional note titles are removed, and the
  offline stored-data flow is an e2e acceptance test.

This status records implementation evidence; it does not relax the requirements below. Update it
only when the corresponding automated acceptance checks pass.

## Phase 0 — Foundations and provider contracts

- Vite + React + TypeScript scaffold, portable domain package, `LocalRepository`, and PWA shell.
- Test harness from the start: Vitest for the domain package, Storybook (with the Vitest addon and
  a11y checks) for component states, Playwright for e2e; MSW handlers shared across all three.
- MapLibre map with hosted OSM-derived vector tiles and required attribution.
- Provider interfaces for map style, search, POI resolution, publishing, and sync (the transport
  ships in Phase 8; the contract exists from the start).
- Select the production provider path; document quotas, licensing/attribution, and the self-hosted
  escape path. Public/demo OSM services remain development-only, and production configuration
  fails closed instead of silently using those defaults.
- A simple performance budget: map shell and first tiles usable within ~2s on a mid-range phone
  over 4G, captured by a repeatable throttled acceptance check (formal p75/p95 budgets on named
  reference devices land in Phase 9, the hardening phase).
- Geolocation fallback: denial, timeout, or unavailability never blocks the map/search UI.

**Done when:** the cached shell launches offline, the map works online with correct attribution, and
provider failures produce designed states rather than blank screens.

## Phase 1 — Find, inspect, and improve OSM places

- Search-as-you-type through the selected provider; normalize every selectable result to a typed OSM
  node/way/relation candidate.
- Tap/search result → exact POI resolution with name, category, address, normalized website, phone,
  hours, OSM version, and representative point.
- Bounded live-POI discovery, preferably from compatible vector tiles with selected-item hydration.
- Place sheet: a single small **View on OpenStreetMap** portal link (in-app edit/report/refresh
  actions and the freshness surface are deferred — see spec/src/map-view.md).
- Long press → nearby OSM candidate picker. If absent, **Add it on OpenStreetMap**, then retry after
  downstream services update — or keep the spot as an **unlinked manual pin** (added to a list once
  the library lands in Phase 2).

**Done when:** I can find a café, inspect its source, see its website, and hand a missing/wrong POI
off to OpenStreetMap without creating a second public correction record.

## Phase 2 — Durable local-first library and lists

- Create an immutable app `PlaceId` for OSM-backed places only after exact OSM resolution; persist
  current OSM ref, append-only history, first-seen evidence, and last-verified evidence atomically
  with its first list membership.
- **Unlinked manual pins**: offline-capable `origin: "manual"` places with owner-provided facts, a
  distinct badge, and a **Link to OpenStreetMap** upgrade via the candidate picker.
- Implement `resolved`, `stale`, `unavailable`, `missing`, `needs-review`, and `unlinked` states
  (domain model; the freshness UI surface is deferred — spec/src/map-view.md).
- Exact-ref refresh followed only on confirmed disappearance/repurposing by conservative evidence
  matching; ambiguous candidates require owner review.
- Library-place and clustered map layers; membership is existence; tags through `TagAssignment`
  edges.
- Markdown place notes with local media. List-section notes arrive with the later guide layer.
- **Lists first**: named, coloured, ordered place groupings built from ranked `ListBlock` entities.
  Descriptions, section blocks, `BlockNoteAttachment`, and a narrative reading view belong to the
  later guide layer, not to the Phase 2 list.
- Offline views/edits from IndexedDB; live search, uncached tiles, OSM refresh, and OSM-backed place
  creation show clear online requirements.
- Versioned ZIP backup/restore with manifest, checksums, binary media, and attributed OSM evidence.

**Done when:** after the first load, I can view a five-place named and coloured Lisbon list and edit
its stored place tags/notes offline, create an unlinked manual pin into a list offline, restore the
complete library (including media) from a validated backup, and repair a simulated OSM node→way
replacement without losing notes or membership. List reorder/rename/recolour/removal UI arrives in
Phase 3's explicit Edit mode.

## Phase 3 — Interop: Google Maps import & export

The 2026-07-18 pivot: import from the tools people actually use is the front door; our UI is the
editorial layer; navigation hands back out. Design in [Import & Export](./interop.md).

- Import a Google Takeout archive (per-list CSVs + `Saved Places.json`), standalone CSV, KML/KMZ,
  GPX, and GeoJSON into lists — parsed locally; no Google API calls, no link scraping.
- The coordinate ladder for coordinate-less CSV rows: literal URL coordinates → cross-reference
  with the archive's GeoJSON → geocode title+address and score candidates with the existing
  evidence ladder. Auto-place unique high-confidence matches; everything else lands in a
  persisted **review queue** (candidate picker or manual placement).
- Materialize through `addToList` only (membership is existence); imported notes become place
  notes; each Google URL is retained as an **external ref** for provenance and deep links.
- Idempotent re-import: dedup by external-ref id, then name+proximity; converges, never deletes.
- An **import report** accounts for every source row — placed, linked, in review, or skipped.
- **List Edit mode** (supersedes "no edit on the Lists tab" for the edit surface only): reorder,
  remove, rename, recolour — imported lists are too big for place-card-only curation.
- Export any list as KML/KMZ (My Maps-compatible, with feature/size-limit warnings),
  Takeout-shaped CSV, GeoJSON, and GPX; golden-snapshot tests for every writer.
- Place-card **navigation handoff**: Open in Google Maps (external ref URL when present) and
  Apple Maps deep links alongside the OSM portal link.
- Licensing valves enforced: imported Google facts never pre-fill OSM handoffs; OSM-derived
  fields in exports carry ODbL attribution.

**Done when:** I can run Takeout on a real Google account, drop the archive into Placemarks,
clear the review queue, see every list on the map wearing its marker with no row unaccounted for,
open a place in Google Maps from its card, and export a list as KML that Google My Maps accepts.

## Phase 4 — Snapshot sharing

- Public read-only guide viewer using the versioned `SharedGuide` schema.
- Fragment-encoded snapshot links with compressed/inflated size limits, schema validation, and
  decompression protection.
- Share preview listing exactly which notes, tags, and OSM evidence leave the device, plus which
  media are omitted from the snapshot.
- Exact OSM resolution plus evidence-based temporary recovery; fallback states remain visible.
- **Add this guide to my library** using reference/history/evidence deduplication; unresolved new
  places remain pending previews until an exact or unique high-confidence OSM match succeeds.
  Shared manual pins import as unlinked places.

**Done when:** I can send a read-only guide without a backend, the recipient cannot modify it, and
the link still renders timestamped evidence when its old OSM element no longer resolves.

## Phase 5 — Persistent creator-updatable links and note pages

- Hosted named guide and note URLs: public, guessable, and strictly read-only.
- Before atomic slug creation, the client generates and persists a high-entropy editor bearer token;
  the request sends it over TLS and the server stores only its hash.
- Bearer-authorized `PUT`/`DELETE`, ETags/`If-Match`, idempotency keys, rate/payload limits,
  versioned storage, audit records, and non-reusable revoked-slug tombstones.
- Durable publication outbox and visible `queued`, `publishing`, `published`, `failed`, `revoking`,
  and `revoked` state.
- Creator edits update the public page only after a successful publish; out-of-order retries cannot
  roll it back.
- Validating media service: server-issued ids, quotas, re-encoding, EXIF stripping, SVG rejection,
  cookieless CDN, reference tracking, and cleanup.
- Standalone read-only Markdown note pages with the same bearer-token/revision model.
- Public pages default to `noindex` and show current OSM attribution/resolution status.

**Done when:** a creator can update or revoke a persistent read-only guide while any visitor with
only the public link can read—but never modify—its latest successfully published revision.

> **Status (2026-07-19): implemented in code**, except the media service, which is deferred — the
> share service rejects hosted-media claims until it exists ([notes](./notes.md#publishing-a-note-page)).
> The service is the Hono app in `services/share` behind a `ShareStorage` port (in-memory for
> tests/dev via MSW, D1 adapter + `schema.sql`/`wrangler.toml` for deployment). Deployment,
> domain, and CDN wiring are operational tasks outside the codebase.

## Phase 6 — The canvas shell: lists-first pane & the persistent map (pivot, part 1)

The 2026-07-19 pivot's UI half: one layout grammar — a content pane beside a persistent map
canvas ([Views](./map-view.md#the-grammar)) — opening on the curation.

- **The pane-and-canvas shell**: routes render into the content pane; the map becomes a
  singleton canvas in the app shell outside the route outlet (no re-mount on navigation,
  viewport survives route changes). Three pane states — collapsed / split / expanded — as sheet
  detents (peek / half / full) on mobile. Existing pages (lists, list, place card, review,
  settings) migrate into the pane.
- **Canvas idling at full scale** (2026-07-19, late): while the pane/sheet fully occludes the
  canvas, rendering pauses and viewport discovery stops; projection changes defer and coalesce,
  applying as one camera move on reveal.
- **Lists home** as the pane's `/` route and launch state (pane expanded/full) — each list with
  marker, name, place count, posts link, and a fixed-length truncated inline preview.
- **Route → projection wiring**: home projects all lists, a list its members (library dimmed),
  the review queue its labelled candidates on the main canvas (retiring the bespoke mini map);
  selection bidirectional.
- **Unique per-list markers (icon + colour)**: assignment and uniqueness rules, migration of
  colour-only lists, KML style mapping on import/export, the multi-list stacked/badged variant,
  and the unlinked dot replacing the distinct orange manual-pin marker.
- **List toggles** as the canvas's primary filter; category chips demoted to live-POI discovery.
- **Add to a list from the map** polished as the core curation gesture — the canvas stays
  interactive beside a list's Edit mode.
- **Bottom-up teardown, list/place half** (2026-07-19 late): deleting a list requires it to be
  empty; a place's existence-ending removal is refused while it carries live notes; Edit mode
  gains **Remove all places** with an actionable blocker report. (The post-embed prerequisite
  lands with Phase 7.)

**Done when:** launch opens the Lists home pane over the canvas (offline included); collapsing
the pane is the all-lists map, every list's points wearing visibly distinct markers; toggling a
list hides its points; navigating home → list → place never re-mounts the map or loses the
viewport; reading or writing at full scale leaves the canvas verifiably idle — no frames, no
tile or discovery traffic — until it is revealed again; I can grow a list from the map without
leaving it; and deleting a noted place or a non-empty list is refused with the blockers named
rather than cascading.

> **Status (2026-07-20): implemented in code.** The shell is the pane beside the singleton
> canvas (`src/router.tsx` + `src/map/MapCanvas.tsx`; detents in `src/state/pane.ts`, route
> projections in `src/state/projection.ts`); idling is pinned by
> `src/map/phase6-canvas-idle.audit.test.tsx` (no discovery traffic while occluded; deferred
> projections coalesce into one camera move on reveal). Markers are unique (colour, icon)
> pairs with a Latin-square auto-assignment (`packages/domain/src/markers.ts`), sprite-rendered
> on the canvas, migrated from colour-only lists (Dexie v7), and round-tripped through KML
> style ids (`placemarks-<icon>`). Bottom-up teardown (list/place half) is enforced in the
> repository with actionable blocker reports surfaced on the list page and place card.

## Phase 7 — Posts: the editorial layer (pivot, part 2)

The pivot's data half: **the post is the guide — an editorialised list** ([Posts](./posts.md)).

- `Post`/`PostBlock` entities; migrate the list-borne guide layer (section blocks, note
  attachments, tag selections, list-targeted notes) onto posts; `Publication.target` gains
  `kind: "post"`; lists keep membership only.
- Post **block editor**: prose sections in the full-screen Markdown editor, embeds picked from
  the post's list or the map (add-to-list-then-embed for new places).
- **Bottom-up teardown, post half**: removing a place from a list is refused while a post about
  that list embeds it; deleting a list additionally requires deleting its posts first; deleting
  a post removes its blocks and section notes and touches nothing else.
- Post **reading page** in the pane-and-canvas shell: the canvas follows the article as it
  scrolls (instant under reduced motion); list ↔ posts navigation in both directions; the public
  viewer reuses the same shell read-only.
- Post **publishing**: snapshot and hosted links under `/s/posts`; the shared post names its list
  and carries the list's public slug when one exists; the preflight offers to publish the list
  alongside the post.

**Done when:** I can write a post about a list — two prose sections around three place embeds —
read it beside the map, publish it, and a reader can open the associated list's public page from
the post; documents published before the pivot keep serving unchanged under their slugs.

> **Status (2026-07-20): implemented in code.** `Post`/`PostBlock`/`BlockTagSelection` with the
> full cross-entity invariant set live in the repository; the Dexie v7 upgrade (shared with
> pre-pivot backup restores via `src/data/pivot.ts`, DERIVED ids so re-running converges)
> migrates the list-borne guide layer onto same-titled posts and retargets their publications,
> which keep serving from `/s/lists` under their slugs (`Publication.channel`). The block
> editor (`/post/:id/edit`, embed picker + "Embed in post" on the place card), the reading page
> with the article-following canvas, and post publishing (snapshot + hosted `/s/posts`, the
> "From the list" association, and the publish-the-list-alongside preflight) are in place;
> teardown's post half is enforced with the rest.

## Phase 8 — Accounts & multi-device sync (promoted into v1, 2026-07-19)

Local storage with remote sync is the initial version, not an optional future
([Storage & Sync](./storage-sync.md#multi-device-sync)).

- Minimal accounts (email link / OAuth) that do nothing but name a sync scope; solo, account-free
  use is unchanged.
- `SyncTransport` over the existing mutation outbox: idempotent push, server-monotonic cursor
  pull, hybrid-logical-clock ordering; per-entity/edge merge with tombstone acknowledgement;
  concurrent Markdown edits produce recoverable conflict copies; place relinks merge append-only
  history conservatively, with conflicting candidate choices becoming `needs-review`.
- A sync status surface: last-synced state, pending mutation count, and conflict review.
- Postgres-backed sync service reusing the shared schemas; deployment and operations documented.

**Done when:** two devices signed into one account converge — lists, posts, notes, tags, places —
after concurrent offline edits without silent loss; a conflicting note edit yields a recoverable
conflict copy; and with sync off the app behaves exactly as the local-first Phases 0–7 build.

> **Status (2026-07-20): implemented in code**, exercised end-to-end by
> `src/features/sync/sync.test.ts` against the real service app. Every repository write logs a
> durable HLC-stamped mutation in the same transaction (Dexie v8 `mutationOutbox`); the engine
> pushes idempotently, pulls the server-monotonic cursor, and applies changes through the
> domain merge policy (`packages/domain/src/sync.ts`): per-row LWW, conflict copies for
> concurrent Markdown edits, conservative append-only place-history merging with
> `needs-review` on conflicting relinks, and teardown-race rescue into a conflict surface.
> Accounts are email-code logins minting per-device bearers (hash-stored); the service is the
> Hono app in `services/sync` behind a `SyncStorage` port (in-memory for tests/dev via MSW,
> Postgres adapter + `schema.sql`/OPERATIONS.md for deployment). The sync status surface lives
> in Settings. Deployment and mailer wiring are operational tasks outside the codebase.

## Phase 9 — Hardening & operations (post-v1; formerly Phase 6)

Deliberately after the v1 line: operational rigor scaled to real usage, not a launch prerequisite.

- Accessibility audit plus continuous keyboard, focus, contrast, screen-reader, and reduced-motion
  acceptance tests.
- Large-library clustering, post rendering, resolver-cache, sync, and publication performance
  work; formalize p75/p95 budgets for Lists-home launch, map shell, and first tiles on named
  reference devices/networks.
- Deepen observability: provider health/quota dashboards and alarms, share-, sync-, and
  media-service metrics, and client error reporting with privacy redaction (no fragment-bearing
  URLs, tokens, or precise locations). No formal error budgets or scheduled failover/recovery
  drills — observability over process.
- Persistent-storage prompts, quota UX, backup reminders, stale-data explanations, and encrypted
  token-backup restore. Without a backup, a lost editor token requires publishing under a new slug.
- Measure intended-place search success, first-list-add completion, post authoring/publish
  completion, creator republish success, recipient opens/imports, stale-resolution rates, and
  unintended-disclosure incidents.

**Done when:** the installed app and public reader are fast, accessible, observable, recoverable,
and good citizens of the OSM ecosystem.

> **Status (2026-07-19): client-side slices implemented ahead of schedule** — continuous axe
> checks over every story (serious/critical violations fail the suite), client error reporting
> with privacy redaction (URL fragments, bearer/labelled/long-base64url tokens, precise
> coordinates), 30-day backup reminders, and backup archive resource caps. Dashboards, alarms,
> CDN/service metrics, and usage measurement remain operational work for a deployed service.

## Phase 10+ — Optional futures

(Accounts and multi-device sync moved into v1 as Phase 8 — 2026-07-19.)

- Import beyond files (file-based Google import landed in Phase 3): shared-link ingestion only if
  an official API appears; Instagram/TikTok and screenshot extraction remain experimental because
  of platform and disambiguation risk.
- Self-hosted tiles, search, and OSM resolver stack.
- Native client reusing portable domain packages.
- Collaborative post editing, which may motivate CRDTs.
- Routing/navigation beyond external deep-links.
- Optional direct OSM editing only with explicit user confirmation, OSM authentication, correct
  tagging, and attributable changesets.
- Folding standalone note pages into posts
  ([questioned 2026-07-19](./posts.md#standalone-note-pages-questioned)).

## Cross-cutting from day one

- Correct OSM/provider attribution and licensing on map, list, post, note, and export surfaces.
- Basic metrics and observability: client error reporting and simple usage/provider-health counters
  from the first release, always with privacy redaction (no fragment URLs, tokens, or precise
  locations). Deeper dashboards/alarms arrive in Phase 9.
- Provider privacy minimization, budgets, caching, cancellation, retry/backoff, and circuit breaking.
- Public links remain read-only; the editor bearer token is private and never enters their URL or
  document.
- No app-wide POI correction layer: public geographic corrections go upstream to OSM.
- No silent identity repair: unavailability retains the old link, ambiguity requires review, and
  copied evidence is never represented as a live observation. Timestamps become visible wherever
  the freshness/public-viewer surface is in scope.
- The local repository remains primary; networks are queued effects with explicit state.
