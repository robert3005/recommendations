# Open Data Sources

> **Adapter and deployment decisions (2026-07-19).**
>
> - Provider adapters own resilience policy so callers never re-create it: result budgets bind
>   locally even when an upstream ignores its limit; Photon retries one transient 5xx; Overpass
>   coalesces concurrent identical viewport queries and negative-caches identical empty
>   viewports for five minutes.
> - A production build fails closed not only on missing provider variables but on the known
>   development/demo hosts (photon.komoot.io, overpass-api.de, api.openstreetmap.org,
>   tiles.openfreemap.org, demotiles.maplibre.org) — copying dev URLs into env vars is not a
>   production provider path.
> - Settings carries the per-provider privacy disclosure: what each request contains (tile
>   coordinates + network metadata; search text + location bias; bounding boxes / element ids),
>   what never leaves the device (note bodies, list names, tags), direct-vs-proxied routing, and
>   retention.
> - A checked-in `_headers` file gives the app and every public viewer one restrictive
>   document-level Content-Security-Policy (self-only scripts, no eval, `object-src 'none'`).
> - Map-surface attribution is a live link to openstreetmap.org/copyright wherever OSM-derived
>   facts are presented — on the map control, public list and post pages, and note pages.

All **live** geographic facts come from OpenStreetMap or OSM-derived services. Placemarks does not
create a second public POI database. It stores bounded OSM observations for identity/offline
recovery and directs corrections upstream.

A second source exists since the 2026-07-18 interop pivot: **files the user exported of their own
data** (Google Takeout, KML/KMZ, GPX, GeoJSON — see [Import & Export](./interop.md)). These are
parsed locally and stored as user-imported facts on the user's own places. They are the user's
personal data, not a proprietary API integration: Placemarks never calls Google services, never
fetches an imported URL, and keeps imported facts technically distinguishable from OSM
observations. The one-way valve matters in both directions — imported Google-derived facts never
pre-fill OSM contributions, and OSM-derived facts carry ODbL attribution wherever they leave the
app ([licensing hygiene](./interop.md#licensing-hygiene)).

## Map tiles

MapLibre GL JS renders vector tiles for crisp zoom, rotation, and runtime styling.

- **Production start:** use a hosted OSM-derived vector provider with an explicit browser-use
  contract, quota, attribution requirement, and availability expectation.
- **Independence path:** serve a [Protomaps](https://protomaps.com/) PMTiles extract from static
  storage/CDN.

Changing providers is an adapter/configuration change, but not necessarily one URL substitution.
Tile schemas, source-layer names, styles, fonts, sprites, feature ids, attribution, licenses, and
API-key restrictions can differ. Application overlays must not depend on a basemap provider's
private layer schema.

### Development basemaps (2026-07-19)

All development-only; the app's own layers sit on top and depend on no basemap schema, so
switching is one `VITE_MAP_STYLE_URL` (see `apps/web/.env.example`):

| Source | Styles | Key | Notes |
|---|---|---|---|
| **OpenFreeMap** (default host) | **bright** (OSM Bright — the dev default), liberty, positron, dark, fiord | none | Keyless, explicitly free, OpenMapTiles schema |
| **VersaTiles** | colorful, graybeard, eclipse, neutrino | none | FLOSS, non-commercial hosted project |
| **Stadia Maps** | osm_bright, alidade, outdoors | none on localhost | Production-contract candidate ([tech stack](./tech-stack.md)) |
| **Protomaps PMTiles** | basemaps styles over a downloaded extract | none (self-hosted file) | The independence path; also the fully-offline dev option |
| MapLibre demotiles | minimal world | none | Smoke tests only — no streets/POIs |

E2e keeps the local `/test-style.json` fixture — deterministic and network-free.

Browser tile keys are public identifiers: origin-restrict them where supported, give them limited
quotas, monitor usage, and make rotation possible without a client release.

## Geocoding and search

Search results must carry a typed OSM element reference when they can become a library place.

- [Photon](https://github.com/komoot/photon) supports search-as-you-type, multilingual search,
  location bias, and typo tolerance.
- [Nominatim](https://nominatim.org/) supports structured forward and reverse geocoding.

The public Nominatim service is limited to light use, has an aggregate one-request-per-second cap,
and explicitly forbids client-side autocomplete. Photon describes `photon.komoot.io` as a demo with
reasonable-use throttling and no availability guarantee. See the
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) and
[Photon demo terms](https://github.com/komoot/photon#demo-server).

Those public endpoints are development/evaluation configurations only. A public Placemarks release
uses a selected managed service or a self-hosted deployment. The provider adapter implements input
debouncing, cancellation, result normalization, attribution, caching, and retry/backoff.
Production configuration is explicit and fail-closed: a production build/deployment must not
silently inherit demo Photon, shared Overpass, or trial tile defaults when required provider
settings are absent.

## POI discovery and resolution

The POI resolver returns OSM tags and a representative point for nodes, ways, and relations. An
Overpass-compatible implementation is useful, but the shared public Overpass instance is not an
application backend. Its own guidance warns general-purpose apps not to rely on the public instance
for production. See [Overpass commons guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).

Production uses a managed resolver/cache or an owned OSM-derived service. Public Overpass is
restricted to manual development traffic.

### Viewport discovery

Prefer POI features already present in compatible vector tiles when possible, then hydrate only a
selected or library item. If the resolver must discover a bounded viewport, query all relevant OSM
element types and impose explicit zoom, area, time, and result budgets:

```overpassql
[out:json][timeout:8];
(
  nwr["amenity"~"cafe|restaurant|bar"]({{bbox}});
  nwr["shop"]({{bbox}});
  nwr["tourism"]({{bbox}});
);
out tags center 100;
```

The UI indicates truncation rather than implying the capped set is complete. Requests are aligned
to reusable tile keys, debounced, cancelled after stale map movements, and protected by retry,
negative caching, circuit-breaking, and stale-while-revalidate behavior.

### Fields we derive

- **Website:** `website` → `contact:website` → `url`.
- **Category:** primary `amenity`, `shop`, `tourism`, `leisure`, `office`, or `craft` tag.
- **Address:** relevant `addr:*` tags.
- **Hours:** raw `opening_hours`, interpreted by a maintained parser.
- **Representative point:** node coordinates or a provider-supplied center for a way/relation.

Only normalized `http:` and `https:` website/social URLs become clickable. OSM values are untrusted
input and never bypass link or Markdown sanitization.

## Durable observation and re-resolution

Adding an OSM-backed place to its first list copies bounded metadata from a successful exact OSM
resolution in the same transaction:

- current element type/id and OSM version;
- name, primary category, coordinates, address, website, phone, and hours;
- selected identity tags such as Wikidata/brand/reference ids;
- observation timestamp.

That observation becomes `Place.firstSeen` and `Place.lastVerified`. Refresh always tries the exact
current element first. Transport failure retains the binding. A confirmed missing or incompatible
element triggers evidence-based candidate search; a unique high-confidence match may relink, while
ambiguous candidates require owner review.

This process is specified in [Durable Place Identity](./place-identity.md). Shared pages carry a
bounded version of the same evidence for first paint and recovery.

## Updating OpenStreetMap upstream

An existing OSM-backed place exposes one small **View on OpenStreetMap** portal link to
`https://www.openstreetmap.org/<type>/<id>`. The portal provides source history plus its own Edit
and report flows; Placemarks does not duplicate those actions on the card. For a missing POI,
**Add it on OpenStreetMap** opens the editor centered on the chosen coordinates. After saving
upstream and allowing indexes to update, the user retries Placemarks search or the candidate
picker.

Placemarks never submits a personal note, tag, or inferred correction to OSM automatically. Direct
in-app OSM editing would require explicit confirmation, OSM authentication, correct tagging, and a
clear changeset comment; it is outside v1.

The hand-off explains that OSM edits and map notes are public. Users should add only verifiable,
non-personal facts they are permitted to contribute, check for an existing feature before adding a
new one, and never copy data from a proprietary places service. This applies with extra force to
[imported](./interop.md) places: Google-sourced names, addresses, and coordinates stored on a
place must never pre-fill an OSM editor hand-off — the user contributes from their own knowledge,
not from our stored Google data.

OSM edits and downstream geocoder/resolver replication are asynchronous. Placemarks keeps the last
verified evidence until the changed or newly created element becomes visible. A dedicated
**Check for OSM updates** action belongs to the deferred freshness surface.

## Privacy and data flow

External providers can observe different slices of activity:

- tile providers receive requested tile coordinates and network metadata;
- geocoders receive search text and any supplied location bias;
- POI resolvers receive bounding boxes or element ids and, during identity recovery, the bounded
  copied name/category/location/address/contact evidence needed to search candidates;
- the share service receives the public projection the owner approved plus normal request metadata;
- the media service/CDN receives approved image bytes/ids and normal request metadata.

Do not send note bodies, list names, tags, or a user's complete library to map/search/POI
providers. Request location only after a user action, minimize precision where it is merely search
bias, and document whether each request is direct or proxied plus the provider's retention terms.
Share/media mutation requests also carry the editor bearer token; it must be redacted before all
logging, tracing, analytics, and error capture. Document operational-log retention and CDN reader
request retention separately from public-document retention.

## Licensing and attribution

OSM data is ODbL; tiles and styles may add other licenses. Requirements include:

- Show linked **© OpenStreetMap contributors** attribution anywhere OSM maps or derived POI facts
  are publicly presented, plus provider-specific credits.
- Preserve source, observation time, attribution, and license metadata on copied identity evidence
  and backups.
- Keep user-authored data technically distinguishable from OSM-derived observations.
- Evaluate insubstantial extraction, collective-database, Produced Work, and Derivative Database
  obligations for aggregate public outputs; “only bulk data matters” is not a sufficient test.
- Complete an ODbL review before public launch of aggregated share/resolution infrastructure.

The [OSMF attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
provide guidance but do not replace the license text or legal advice. Attribution is a first-class
element on map, list, post, note, and export surfaces.
