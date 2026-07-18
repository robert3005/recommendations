# Open Data Sources

All geographic facts come from OpenStreetMap or OSM-derived services. Placemarks does not create a
second public POI database. It stores bounded OSM observations for identity/offline recovery and
directs corrections upstream.

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

Browser tile keys are public identifiers: origin-restrict them where supported, give them limited
quotas, monitor usage, and make rotation possible without a client release.

## Geocoding and search

Search results must carry a typed OSM element reference when they can become a saved place.

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

## POI discovery and resolution

The POI resolver returns OSM tags and a representative point for nodes, ways, and relations. An
Overpass-compatible implementation is useful, but the shared public Overpass instance is not an
application backend. Its own guidance warns general-purpose apps not to rely on the public instance
for production. See [Overpass commons guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).

Production uses a managed resolver/cache or an owned OSM-derived service. Public Overpass is
restricted to manual development traffic.

### Viewport discovery

Prefer POI features already present in compatible vector tiles when possible, then hydrate only a
selected or saved item. If the resolver must discover a bounded viewport, query all relevant OSM
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

Saving a place copies bounded metadata from a successful exact OSM resolution:

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

Every OSM-backed place exposes:

- **View on OpenStreetMap** — `https://www.openstreetmap.org/<type>/<id>` for source, history, and
  editing entry points.
- **Edit on OpenStreetMap** — opens the OSM web editor focused on the current place.
- **Add it on OpenStreetMap** — for a missing POI, opens the editor centered on the chosen
  coordinates; after saving upstream, Placemarks retries search/linking.
- **Report a map issue** — opens the OSM note/report flow for users who cannot confidently edit.

Placemarks never submits a personal note, tag, or inferred correction to OSM automatically. Direct
in-app OSM editing would require explicit confirmation, OSM authentication, correct tagging, and a
clear changeset comment; it is outside v1.

The hand-off explains that OSM edits and map notes are public. Users should add only verifiable,
non-personal facts they are permitted to contribute, check for an existing feature before adding a
new one, and never copy data from a proprietary places service.

OSM edits and downstream geocoder/resolver replication are asynchronous. **Check for OSM updates**
keeps the last verified evidence until the changed or newly created element becomes visible.

## Privacy and data flow

External providers can observe different slices of activity:

- tile providers receive requested tile coordinates and network metadata;
- geocoders receive search text and any supplied location bias;
- POI resolvers receive bounding boxes or element ids and, during identity recovery, the bounded
  copied name/category/location/address/contact evidence needed to search candidates;
- the share service receives the public projection the owner approved plus normal request metadata;
- the media service/CDN receives approved image bytes/ids and normal request metadata.

Do not send note bodies, list titles, tags, or a user's complete saved library to map/search/POI
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
element on map, guide, note, and export surfaces.
