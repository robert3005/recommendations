# Roadmap

Each phase ends with a usable, testable increment. V1 spans **Phases 0–8** (extended 2026-07-19)
because the product thesis includes **interop with the tools people already use** (2026-07-18:
import is the front door — see [Import & Export](./interop.md)), the **lists-first shell with
posts as the editorial layer** (2026-07-19 pivot — see [Posts](./posts.md)), a persistent
read-only link that its creator can update safely, and **multi-device sync**. Phases 2–5 below
were specified and implemented before the pivot; where they say "guide" they describe what is now
a published list or post, and Phases 6–7 carry the pivot's migration.

## Current implementation audit (2026-07-18)

- **Phase 0 — partial.** The application shell, local repository, map, attribution, geolocation
  fallback, PWA, and core test layers exist. Completion still requires the full provider contract
  set (`MapStyleProvider`, `SharePublisher`, and `SyncTransport`), Storybook's Vitest browser addon
  with automated axe checks, an enforced production-provider configuration, evidence for the
  two-second performance budget, and a designed basemap-provider failure state.
- **Phase 1 — functionally complete on the development/test path.** Search, exact POI inspection,
  bounded discovery, the OSM portal handoff, and the missing-place/manual-pin choice satisfy the
  phase acceptance flow. Production readiness remains gated by Phase 0's provider work.
- **Phase 2 — partial.** Durable identity, membership-based existence, manual pins, lists, tags,
  text notes, IndexedDB, and the conservative recovery state machine exist. Completion still
  requires local `asset:` images to render, lossless migration of pre-membership libraries,
  coordinate/id/size/graph validation before backup writes, checksums for binary media,
  fail-closed export when referenced media bytes are unavailable, identity-aware backup merge,
  replacement semantics when an optional note title is cleared, and an offline stored-data
  acceptance flow. Backup merge must never fork two `PlaceId` values for the same exact current or
  historical OSM reference.

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

## Phase 6 — Lists-first shell & the all-lists map (pivot, part 1)

The 2026-07-19 pivot's UI half: the product opens on its curation
([Views — Lists Home & the Map](./map-view.md)).

- Invert primary navigation: the **Lists home** is the start screen — each list with marker,
  name, place count, posts link, and a fixed-length truncated inline preview; the map becomes the
  paired primary view.
- **Unique per-list markers (icon + colour)**: assignment and uniqueness rules, migration of
  colour-only lists, KML style mapping on import/export, the multi-list stacked/badged variant,
  and the unlinked dot replacing the distinct orange manual-pin marker.
- **List toggles** as the map's primary filter; category chips demoted to live-POI discovery.
- **Add to a list from the map** polished as the core curation gesture, including a map that
  stays interactive inside list Edit mode.

**Done when:** launch opens the Lists home (offline included); switching to the map shows every
list's points wearing visibly distinct markers; toggling a list hides its points; and I can grow
a list from the map without leaving it.

## Phase 7 — Posts: the editorial layer (pivot, part 2)

The pivot's data half: **the post is the guide — an editorialised list** ([Posts](./posts.md)).

- `Post`/`PostBlock` entities; migrate the list-borne guide layer (section blocks, note
  attachments, tag selections, list-targeted notes) onto posts; `Publication.target` gains
  `kind: "post"`; lists keep membership only.
- Post **block editor**: prose sections in the full-screen Markdown editor, embeds picked from
  the post's list or the map (add-to-list-then-embed for new places), embed tombstones with
  visible gaps, the detached-post flow when a list is deleted.
- Post **reading page**: interleaved article beside a synchronized map; list ↔ posts navigation
  in both directions.
- Post **publishing**: snapshot and hosted links under `/s/posts`; the shared post names its list
  and carries the list's public slug when one exists; the preflight offers to publish the list
  alongside the post.

**Done when:** I can write a post about a list — two prose sections around three place embeds —
read it beside the map, publish it, and a reader can open the associated list's public page from
the post; documents published before the pivot keep serving unchanged under their slugs.

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
