# Tech Stack

The stack favors fast web delivery, open data, local ownership, and explicit provider boundaries.
Specific vendors are replaceable through contracts; place identity and publication semantics are
not.

## Chosen reference implementation

The sections below define the *contracts*; these are the concrete defaults chosen to implement
them (2026-07). Rule: boring by default, exotic only where the design demands it.

| Layer | Choice | Deciding argument |
|---|---|---|
| Language/tooling | TypeScript `strict`; pnpm workspaces (`domain`/`schemas`/`app`/`services`); Biome + `tsc --noEmit`; GitHub Actions | One language end to end; shared Zod schemas are the wire contract |
| Testing | Three layers: Vitest (node) for domain invariants; **Storybook 9 + Vitest addon** (browser mode) for component states, interactions, and per-story axe a11y; Playwright for e2e (IndexedDB, PWA offline, MapLibre, publish loop); MSW shared everywhere | Stories pin every named design state (`resolved…unlinked`, `queued…revoked`); a11y runs continuously, not as a one-off audit |
| Framework | React 19 + Vite; TanStack Router; TanStack Query; Zustand (ephemeral UI only) | Map hot path is WebGL, so buy ecosystem + RN reuse, not framework perf; Query's stale-while-revalidate is the resolver semantics; typed routes carry slug + viewport state |
| Local data | Dexie + `liveQuery`, isolated in an adapter package | Real multi-store transactions for the data-model invariants; RN later swaps OP-SQLite behind `LocalRepository` |
| Map | MapLibre GL JS used directly (no react-map-gl); **one persistent canvas instance** in the app shell outside the route outlet, idling while fully occluded (2026-07-19) | Own the thin adapter the architecture mandates; routes re-project the singleton canvas instead of re-mounting a map per page; deferred/coalesced projections keep a hidden map off the GPU, network, and tile quota |
| Markdown | unified: remark-parse + remark-gfm + rehype-sanitize (allowlist schema); `opening_hours` parser | AST access for `asset:` rewriting; allowlist is the correct sanitizer polarity |
| Services | Hono on Cloudflare Workers; **D1** for slugs/revisions/audit (not KV — atomic slug claim and `If-Match` CAS need a consistent store); R2 + cookieless CDN for media | Hono makes the platform reversible (same app runs on Node/Fly + Postgres + sharp); scale-to-zero matches an idle-most-of-the-time service; R2 has zero egress |
| Image pipeline | Client re-encode on import (canvas → WebP; strips EXIF by construction); server magic-byte sniff + caps + wasm re-encode (jSquash) | Defense in depth without requiring Node-only `sharp` |
| Token handling | SHA-256 hash + constant-time compare for the 256-bit editor token | Slow hashes (bcrypt) are for low-entropy passwords, not random tokens |
| Production providers | Contracted MapTiler/Stadia tier + vendor geocoder to launch; Protomaps PMTiles on R2 as the independence move; exact-ref reads via OSM API 0.6 + viewport POIs from basemap tiles; no self-hosted Overpass in v1 | One contract to start; each escape path stays cheap and concrete |
| Interop | PapaParse (CSV), `@tmcw/togeojson` (KML/GPX → GeoJSON), fflate (Takeout ZIP — already the backup dependency); hand-written KML/GPX/CSV export templates | Files are the integration surface — no Google SDKs, no scraping; writers are golden-snapshot tested |
| Styling / PWA | Tailwind v4; vite-plugin-pwa | Non-architectural; fastest solo iteration |

**Explicitly rejected:** Next.js (SSR buys nothing behind a map canvas; OG previews for share
slugs are one worker route), Redux, GraphQL, Prisma, Supabase/Firebase (their auth model fights
bearer-token publications), sync engines (Replicache/PowerSync/Electric — their data models fight
`PlaceId` + outbox semantics; re-evaluate once before building the Phase 8 sync backend), CRDTs,
Kubernetes/Terraform.

## Web client

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript | Shared portable domain types |
| Framework | React + Vite | Responsive SPA and PWA shell |
| Map | MapLibre GL JS | Open-source vector rendering |
| Tiles | Contracted hosted OSM vectors | Protomaps PMTiles independence path |
| Search | Managed/self-hosted Photon; Nominatim where appropriate | Public/demo services are development-only |
| POI resolver | Managed resolver/cache or owned Overpass-compatible service | Exact OSM lookup and evidence search |
| Local data | IndexedDB via Dexie | Durable primary repository and outboxes |
| State | Lightweight UI store such as Zustand | Domain truth stays in repository/entities |
| Markdown | CommonMark + GFM parser and sanitizer | Same safe pipeline in app/public viewer |
| PWA | Vite PWA plugin | Offline app shell from the local-first milestone |

IndexedDB stores places (with OSM evidence and external refs), tags/assignments, notes/media,
lists/blocks, posts/blocks/note attachments, import batches/items, publications, credentials, and
mutation/publication outboxes. Binary media is separate
from portable domain metadata.

## Domain packages

Plain TypeScript packages contain durable place identity, resolver scoring/state transitions,
list and post construction, public projection, and publication state. They have no direct dependency on
React, IndexedDB, `Blob`, DOM parsing, MapLibre, or `fetch`.

## OSM resolver path

Public Nominatim, Photon demo, and public Overpass may support manual development within their
policies. They are not production dependencies. A production release has a selected managed or
self-hosted path with:

- typed node/way/relation lookup and representative centers;
- request coalescing, cache/negative cache, retry/backoff, and circuit breaking;
- bounded evidence-based candidate search;
- provider monitoring, quotas, attribution, privacy documentation, and a switch plan.

## Share and media services

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Small Node/TypeScript service or edge function | Same schemas as public projections |
| Document storage | D1 (SQLite); Postgres is the portable alternative | Atomic slug claims, conditional revisions, versioned list/post/note JSON, and tombstones require consistent transactions |
| Public API | REST | Public `GET`; Bearer-authorized conditional mutations |
| Concurrency | ETag / `If-Match` + idempotency keys | Prevent stale/out-of-order publication |
| Write ownership | Random device-held editor bearer token; hash server-side | No account and no token in public link |
| Media | Validating image pipeline + cookieless object storage/CDN | Server-issued ids; quotas and lifecycle cleanup |

The public URL is always read-only. The creator's local `Publication.credentialId` points to the
secret required to update or revoke it.

## Sync backend (v1 since 2026-07-19)

| Concern | Choice | Notes |
|---|---|---|
| API | TypeScript REST | Idempotent mutation push + cursor pull |
| Database | Postgres | PostGIS optional for server-side geo use cases |
| Auth | Email link / OAuth | Names the sync scope only; solo use needs no account |
| Ordering | Mutation id + actor + HLC/server cursor | Client wall clock is not conflict order |
| Merge | Per entity/edge with tombstones | Conflicting Markdown bodies preserve a copy |

Sync transport is separate from `LocalRepository`; application reads and writes stay local.

## Self-hosting and independence

- **Tiles:** Protomaps PMTiles from OSM extracts on static storage/CDN.
- **Search:** self-hosted Photon and/or Nominatim.
- **POI resolution:** owned Overpass-compatible instance or an extract-backed resolver/cache.
- **Shares:** small document/media service with editor-token hashes and versioned backups.

## Explicitly deferred

- Native app, after the web core loop is validated.
- Collaborative post editing and any CRDT work. (Accounts and multi-device sync moved **into**
  v1 on 2026-07-19; backup/restore and read-only public shares still land first.)
- Routing beyond external deep-links.
- Direct in-app OSM editing; v1 opens the OSM website/editor with explicit user control.
