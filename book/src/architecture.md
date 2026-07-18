# Architecture Overview

## Shape of the system

```text
┌────────────────────────────────────────────────────────────────────┐
│ Web client                                                         │
│                                                                    │
│  Map / search UI       Guide editor       Public read-only viewer │
│          │                  │                         │             │
│  ┌───────┴──────────────────┴─────────────────────────┴──────────┐ │
│  │ Core domain                                                 │ │
│  │ Place identity · conservative OSM relinking · tags · notes │ │
│  │ ordered guide blocks · publication projections             │ │
│  └───────────────┬───────────────────┬──────────────────────────┘ │
│                  │                   │                            │
│       ┌──────────▼─────────┐  ┌──────▼────────────────────────┐  │
│       │ LocalRepository    │  │ Effect interfaces             │  │
│       │ IndexedDB primary  │  │ search · POI resolve · share │  │
│       └──────────┬─────────┘  │ publish · optional sync       │  │
│                  │            └──────────────┬────────────────┘  │
│       mutation/publication                  │                   │
│              outboxes                       │                   │
└──────────────────┼───────────────────────────┼───────────────────┘
                   │                           │
          optional sync API      managed/self-hosted OSM services
                                share service · media service
```

## Layers and boundaries

### 1. UI

React components own presentation and interaction: map, search, place detail, guide editing,
resolution review, publication status, and the public read-only viewer. Mobile uses sheets; wider
screens use panels. Every map workflow has an equivalent list representation.

### 2. Core domain

Framework-independent TypeScript owns:

- immutable app `PlaceId` values and mutable OSM bindings;
- first-seen/last-verified evidence and the conservative re-resolution state machine;
- saved places, tags, Markdown notes, lists, ordered blocks, and note attachments;
- construction of explicit public projections;
- publication state transitions.

The domain never calls `fetch`, IndexedDB, DOM APIs, or a map SDK directly. Browser-specific blob
handles and rendering stay in adapters, preserving reuse in a future native client.

### 3. Local repository

`LocalRepository` is the only repository used for application reads and writes. IndexedDB is its web
implementation. Transactions keep aggregate changes consistent, and durable outboxes record
network work after the local commit.

A future `SyncTransport` is not a network-flavored replacement repository. It pushes and pulls
mutations in the background while the app continues to read and write locally. `SharePublisher`
similarly drains only explicit publication jobs.

See [Storage & Sync](./storage-sync.md).

### 4. External service adapters

External concerns have explicit interfaces:

```ts
interface SearchProvider { /* forward/reverse search with typed OSM candidates */ }
interface PoiResolver { /* exact ref lookup + evidence candidate search */ }
interface MapStyleProvider { /* style, tile schema, attribution and capabilities */ }
interface SharePublisher { /* Bearer-authorized publish/revoke */ }
interface SyncTransport { /* optional idempotent push/pull */ }
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
  missing POI facts lead to View/Edit on OpenStreetMap and a later refresh.
- **Local commits do not wait for networks.** Refresh, publish, revoke, and sync are explicit queued
  effects with visible pending/failure states.
- **Shared URLs are read-only.** A hosted slug grants public read access only. Its creator updates or
  revokes content using a separate device-held editor bearer token.
- **Publication freshness is honest.** A link shows the latest successfully published guide
  revision and latest successfully resolved OSM observation, with timestamped fallback otherwise.
- **Relationships have one owner.** List blocks, tag assignments, and note attachments are canonical
  edge entities rather than duplicated arrays.
- **Providers are replaceable through contracts.** Code depends on typed capabilities and failure
  semantics, not one provider's payload shape.
