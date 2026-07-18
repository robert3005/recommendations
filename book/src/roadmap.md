# Roadmap

Each phase ends with a usable, testable increment. V1 spans Phases 0–4 because the product thesis
includes a persistent read-only link that its creator can update safely.

## Phase 0 — Foundations and provider contracts

- Vite + React + TypeScript scaffold, portable domain package, `LocalRepository`, and PWA shell.
- MapLibre map with hosted OSM-derived vector tiles and required attribution.
- Provider interfaces for map style, search, POI resolution, publishing, and future sync.
- Select the production provider path; document quotas, licensing/attribution, and the self-hosted
  escape path. Public/demo OSM services remain development-only.
- A simple performance budget: map shell and first tiles usable within ~2s on a mid-range phone
  over 4G (formal p75/p95 budgets on reference devices land in Phase 5).
- Geolocation fallback: denial, timeout, or unavailability never blocks the map/search UI.

**Done when:** the cached shell launches offline, the map works online with correct attribution, and
provider failures produce designed states rather than blank screens.

## Phase 1 — Find, inspect, and improve OSM places

- Search-as-you-type through the selected provider; normalize every saveable result to a typed OSM
  node/way/relation candidate.
- Tap/search result → exact POI resolution with name, category, address, normalized website, phone,
  hours, OSM version, and representative point.
- Bounded live-POI discovery, preferably from compatible vector tiles with selected-item hydration.
- Place sheet actions: **View/Edit on OpenStreetMap**, **Report a map issue**, and
  **Check for OSM updates**.
- Long press → nearby OSM candidate picker. If absent, **Add it on OpenStreetMap**, then retry after
  downstream services update — or keep the spot as an **unlinked manual pin** (saved once the
  library lands in Phase 2).

**Done when:** I can find a café, inspect its source, see its website, and hand a missing/wrong POI
off to OpenStreetMap without creating a second public correction record.

## Phase 2 — Durable local-first library and guides

- Create an immutable app `PlaceId` for OSM-backed saves only after exact OSM resolution; persist
  current OSM ref, append-only history, first-seen evidence, and last-verified evidence atomically
  with the save.
- **Unlinked manual pins**: offline-capable `origin: "manual"` places with owner-provided facts, a
  distinct badge, and a **Link to OpenStreetMap** upgrade via the candidate picker.
- Implement `resolved`, `stale`, `unavailable`, `missing`, `needs-review`, and `unlinked` states.
- Exact-ref refresh followed only on confirmed disappearance/repurposing by conservative evidence
  matching; ambiguous candidates require owner review.
- Saved-place and clustered map layers; save/unsave; tags through `TagAssignment` edges.
- Markdown place/list notes with local media.
- Guides built from ranked `ListBlock` entities and explicit `BlockNoteAttachment` records.
- Offline views/edits from IndexedDB; live search, uncached tiles, OSM refresh, and creation show
  clear online requirements.
- Versioned ZIP backup/restore with manifest, checksums, binary media, and attributed OSM evidence.

**Done when:** I can build and edit a five-place Lisbon guide offline after first load, restore it
from backup, and repair a simulated OSM node→way replacement without losing notes or membership.

## Phase 3 — Snapshot sharing

- Public read-only guide viewer using the versioned `SharedGuide` schema.
- Fragment-encoded snapshot links with compressed/inflated size limits, schema validation, and
  decompression protection.
- Share preview listing exactly which notes, tags, OSM evidence, and hosted media leave the device.
- Exact OSM resolution plus evidence-based temporary recovery; fallback states remain visible.
- **Save this guide** import using reference/history/evidence deduplication; unresolved new places
  remain pending previews until an exact or unique high-confidence OSM match succeeds. Shared
  manual pins import as unlinked places.

**Done when:** I can send a read-only guide without a backend, the recipient cannot modify it, and
the link still renders timestamped evidence when its old OSM element no longer resolves.

## Phase 4 — Persistent creator-updatable links and note pages

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

## Phase 5 — Hardening & operations (post-v1)

Deliberately after the v1 line: operational rigor scaled to real usage, not a launch prerequisite.

- Accessibility audit plus continuous keyboard, focus, contrast, screen-reader, and reduced-motion
  acceptance tests.
- Large-library clustering, guide rendering, resolver-cache, and publication performance work;
  formalize p75/p95 map-shell and first-tile budgets on named reference devices/networks.
- Provider dashboards, error budgets, failover drills, quota alarms, backup/restore drills, and
  share-service recovery testing.
- Persistent-storage prompts, quota UX, backup reminders, stale-data explanations, and encrypted
  token-backup restore. Without a backup, a lost editor token requires publishing under a new slug.
- Measure intended-place search success, first-save completion, creator republish success, recipient
  opens/imports, stale-resolution rates, and unintended-disclosure incidents.

**Done when:** the installed app and public reader are fast, accessible, observable, recoverable,
and good citizens of the OSM ecosystem.

## Phase 6+ — Optional futures

- Accounts and multi-device sync using idempotent mutation push, server cursors, per-edge merging,
  tombstone acknowledgement, and recoverable note conflicts.
- Import from Google/Apple Maps links first; Instagram/TikTok and screenshot extraction remain
  experimental because of platform and disambiguation risk.
- Self-hosted tiles, search, and OSM resolver stack.
- Native client reusing portable domain packages.
- Collaborative guide editing, which may motivate CRDTs.
- Routing/navigation beyond external deep-links.
- Optional direct OSM editing only with explicit user confirmation, OSM authentication, correct
  tagging, and attributable changesets.

## Cross-cutting from day one

- Correct OSM/provider attribution and licensing on map, guide, note, and export surfaces.
- Provider privacy minimization, budgets, caching, cancellation, retry/backoff, and circuit breaking.
- Public links remain read-only; the editor bearer token is private and never enters their URL or
  document.
- No app-wide POI correction layer: public geographic corrections go upstream to OSM.
- No silent identity repair: unavailability retains the old link, ambiguity requires review, and
  copied evidence remains visibly timestamped.
- The local repository remains primary; networks are queued effects with explicit state.
