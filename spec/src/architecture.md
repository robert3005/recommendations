# Architecture Overview

Placemarks is a client-only web application plus one small share service. Everything the user
edits lives in the browser; the service holds published documents and nothing else.

## Shape of the system

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Web client                                                           │
│                                                                      │
│  Notebook (home · list · post reading/editing · import review ·      │
│  public viewer) beside the one persistent map canvas                 │
│                                 │                                    │
│  ┌──────────────────────────────┴───────────────────────────────┐    │
│  │ Core domain (pure TypeScript)                                │    │
│  │ model invariants · projections · publish-time link rewriting │    │
│  │ deep-link building/parsing · the import ladder               │    │
│  └──────────────┬─────────────────────────────────┬─────────────┘    │
│  ┌──────────────▼───────────────┐  ┌──────────────▼───────────────┐  │
│  │ LocalRepository              │  │ Adapters                     │  │
│  │ IndexedDB via Dexie          │  │ Geocoder · MapStyleProvider  │  │
│  └──────────────────────────────┘  │ SharePublisher               │  │
│                                    └──────────────┬───────────────┘  │
└───────────────────────────────────────────────────┼──────────────────┘
                                                    │
               hosted tiles · geocoder endpoints · share service
               (Hono + D1 — holds published documents, nothing else)
```

## Layers and boundaries

### 1. UI

React components own presentation and interaction under one layout grammar: every route renders
in the notebook beside the persistent map canvas — a MapLibre singleton in the app shell that
never remounts and keeps its viewport across routes. See [The Notebook & the Map](./map-view.md).

### 2. Core domain

Framework-independent TypeScript owns the rules of the model:

- model invariants — the library owns places, entry and marker uniqueness, the teardown refusals;
- projections — which places a route or post puts on the canvas;
- publish-time link rewriting from `place:`/`post:` protocols to fragments and public URLs;
- deep-link building and parsing for Google Maps, Apple Maps, and OSM URLs;
- the import ladder that turns Takeout rows into placed, reviewed, or skipped items.

The domain never calls `fetch`, IndexedDB, the DOM, or the map SDK directly.

### 3. Local repository

`LocalRepository` is the only read/write path for application data, implemented on IndexedDB via
Dexie. Its transactions enforce the model invariants at the storage boundary. See
[Local Storage](./storage.md).

### 4. Adapters

External concerns sit behind three interfaces: `Geocoder`, `MapStyleProvider`, and
`SharePublisher`. The `Geocoder` is one adapter with two calls that may bind to two endpoints:
`search(text, bias?)` serves the search field and the import ladder, `lookup(osmRef)`
serves pasted OSM element URLs. `MapStyleProvider` supplies the basemap style and attribution;
`SharePublisher` speaks the share service's Bearer protocol ([Sharing & Publishing](./sharing.md)).
Adapters capture failure behaviour and attribution terms, not just endpoint URLs; see
[Map Data & Providers](./data-sources.md).

## One module for deep links

Deep links are built and parsed in one core-domain module: the place card, every export writer,
and the public viewer emit the same Google Maps, Apple Maps, and OSM URLs for a place, and the
search field parses pasted links with the same code. See [Import & Export](./interop.md).

## Key decisions

- **Durable identity is app-owned.** All content joins on `PlaceId`; provenance references
  (`googleUrl`, `appleUrl`, `osmRef`) ride along as deep-link and dedup keys.
- **Local commits never wait for a network.** Reading and editing are IndexedDB transactions;
  geocoding, tiles, and publishing are the only calls that leave the device.
- **Remote state is published documents, and an encrypted library when sync is on.** No
  accounts. The service stores and orders ciphertext; merging happens on the device
  ([Sync Between Devices](./sync.md)).
- **Public URLs are read-only.** Updating or revoking a page requires the per-publication
  editor token, held on the device that published it.
- **Explicit publish only.** No queues, no outboxes, no background effects; retry is the button.
- **Providers are replaceable through contracts.** Code depends on typed capabilities and
  failure semantics, not one provider's payload shape.
