# Architecture Overview

## Shape of the system

```text
┌────────────────────────────────────────────────────────────────────┐
│ Web client                                                         │
│                                                                    │
│  Content pane (home · list · post · review · ⚙ · public viewers)  │
│  beside one persistent map canvas                                  │
│          │                  │                         │             │
│  ┌───────┴──────────────────┴─────────────────────────┴──────────┐ │
│  │ Core domain                                                  │ │
│  │ Place identity · conservative OSM relinking · tags · notes   │ │
│  │ list membership · ordered post blocks · public projections   │ │
│  └───────────────┬───────────────────┬──────────────────────────┘ │
│                  │                   │                            │
│       ┌──────────▼─────────┐  ┌──────▼────────────────────────┐  │
│       │ LocalRepository    │  │ Effect interfaces             │  │
│       │ IndexedDB primary  │  │ search · POI resolve · share │  │
│       └──────────┬─────────┘  │ publish · sync                │  │
│                  │            └──────────────┬────────────────┘  │
│       mutation/publication                  │                   │
│              outboxes                       │                   │
└──────────────────┼───────────────────────────┼───────────────────┘
                   │                           │
              sync API           managed/self-hosted OSM services
                                share service (Hono/D1) · sync service (Hono/Postgres)
                                shared: packages/service-kit
```

## Layers and boundaries

### 1. UI

React components own presentation and interaction under one layout grammar (2026-07-19 —
[Views](./map-view.md#the-grammar)): routes render into a **content pane** (Lists home, list,
post reader/editor, review, settings, public viewers) beside a **persistent map canvas** — a
singleton MapLibre instance in the app shell, outside the route outlet — that projects the
pane's places. Desktop splits pane/canvas; mobile renders the pane as a detented sheet over the
canvas. Selection is bidirectional, and the pane doubles as the map's equivalent non-map
representation.

### 2. Core domain

Framework-independent TypeScript owns:

- immutable app `PlaceId` values and mutable OSM bindings;
- first-seen/last-verified evidence and the conservative re-resolution state machine;
- membership-backed places, tags, Markdown notes, lists, posts with ordered blocks, and note
  attachments;
- construction of explicit public projections;
- publication state transitions.

The domain never calls `fetch`, IndexedDB, DOM APIs, or a map SDK directly. Browser-specific blob
handles and rendering stay in adapters, preserving reuse in a future native client.

### 3. Local repository

`LocalRepository` is the only repository used for application reads and writes. IndexedDB is its web
implementation. Transactions keep aggregate changes consistent; a durable mutation outbox records
sync work after the local commit, and one keyed row per publication holds its pending publish or
revoke.

`SyncTransport` (v1 scope since 2026-07-19) is not a network-flavored replacement repository. It
pushes and pulls mutations in the background while the app continues to read and write locally.
`SharePublisher` similarly drains only explicit publication jobs.

See [Storage & Sync](./storage-sync.md).

### 4. External service adapters

External concerns have explicit interfaces:

```ts
interface SearchProvider { /* forward/reverse search with typed OSM candidates */ }
interface PoiResolver { /* exact ref lookup + evidence candidate search */ }
interface MapStyleProvider { /* style, tile schema, attribution and capabilities */ }
interface SharePublisher { /* Bearer-authorized publish/revoke */ }
interface SyncTransport { /* idempotent push/pull; v1 */ }
```

Adapters capture more than an endpoint URL: schema mapping, attribution, request budget, retry and
failure behavior, privacy terms, cache policy, supported OSM element types, and provider-specific
capabilities all belong at this boundary.

| Concern | Development/evaluation | Production | Independence path |
|---|---|---|---|
| Map tiles | Hosted OSM-derived trial | Contracted hosted vector provider | Protomaps PMTiles |
| Search/geocoding | Public demo within policy | Managed or self-hosted Photon/Nominatim | Self-hosted service |
| POI resolve | Public Overpass for manual development | Managed resolver/cache or owned service | Self-hosted Overpass/extract |

Public Nominatim, Photon demo, and public Overpass are not the production backend. Production
provider selection and capacity are release prerequisites, not later polish. See
[Open Data Sources](./data-sources.md).

## Key decisions

- **Durable identity is app-owned.** User content joins through an immutable `PlaceId`. The current
  OSM node/way/relation link can change while copied evidence and link history preserve continuity.
- **OSM remains the public source of truth.** Placemarks has no global correction overlay. Wrong or
  missing POI facts lead to the OpenStreetMap portal, where the user may inspect, edit, or report
  the source; the app retries its own lookup only after upstream services update.
- **Local commits do not wait for networks.** Refresh, publish, revoke, and sync are explicit queued
  effects with visible pending/failure states.
- **Shared URLs are read-only.** A hosted slug grants public read access only. Its creator updates or
  revokes content using a separate device-held editor bearer token.
- **Publication freshness is honest.** A link shows the latest successfully published
  revision and latest successfully resolved OSM observation, with timestamped fallback otherwise.
- **Relationships have one owner.** List blocks, tag assignments, and note attachments are canonical
  edge entities rather than duplicated arrays.
- **Providers are replaceable through contracts.** Code depends on typed capabilities and failure
  semantics, not one provider's payload shape.
