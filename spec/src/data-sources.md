# Map Data & Providers

Placemarks reads geographic facts from OpenStreetMap and OSM-derived services, and stores the
user's own copy of those facts on their places. It builds no second public POI database, calls no
proprietary API, and scrapes nothing: pasted Google and Apple Maps URLs are parsed locally and
never fetched. The one network call at paste time is the geocoder `lookup(osmRef)` for OSM element
URLs, and it fails politely offline (nothing queues; retry online).

## Map tiles

MapLibre GL JS renders hosted OSM-derived vector tiles — crisp zoom, rotation, and runtime
styling. Production uses a contracted provider with an explicit browser-use contract, quota, and
attribution requirement. The basemap is restyled to the neutral, desaturated light palette of
[Visual Design](./design.md) so accent pins are the loudest thing on the canvas; the linked OSM
attribution control is always visible.

Development builds may point `VITE_MAP_STYLE_URL` at a keyless host — OpenFreeMap (the default),
VersaTiles, Stadia Maps on localhost, or MapLibre demotiles for smoke tests — while e2e keeps a
local style fixture. The independence path is a [Protomaps](https://protomaps.com/) PMTiles
extract served from static storage, which doubles as the fully offline development option.
Application overlays depend on no basemap layer schema, so switching providers is a configuration
change.

## Geocoder

One adapter, two calls, possibly two endpoints:

- `search(text, bias?)` — forward geocoding via a Photon-class **or** Pelias-class autocomplete
  endpoint, selected by `VITE_GEOCODER` (`photon` is the keyless development default; `pelias`
  requires `VITE_PELIAS_URL`, with an optional `VITE_PELIAS_KEY` sent as a query parameter).
  Serves the add-a-place field and the Title + Address step of the import coordinate ladder
  ([Import & Export](./interop.md)).
- `lookup(osmRef)` — exact element fetch via a Nominatim `/lookup`-class endpoint or the OSM API.
  Serves OSM element URL paste.

A search candidate records the result's `osmRef` whenever the upstream sources it from OSM
([Data Model](./data-model.md)); Photon-class results always do. Pelias-class results may come
from other open sources (OpenAddresses, Who's on First) and then carry no `osmRef` — such a pick
behaves like manual placement: no ODbL attribution claim, no OSM element link. The adapter owns
debouncing, cancellation, result normalisation, and retry; callers see plain candidate lists.

Public endpoints such as photon.komoot.io and nominatim.openstreetmap.org carry strict usage
policies and are development-only configurations. Production configuration is explicit and fails
closed with either geocoder kind: a production build with any capability unconfigured refuses to
run against public defaults.

## Wikipedia summaries

When an OSM element's `wikipedia` tag names an article, the app may fetch that one article's
summary from the Wikipedia REST API (`https://<lang>.wikipedia.org/api/rest_v1/page/summary/…`,
keyless and CORS-open; the language defaults to `en` when the tag has no prefix) to fill a
place's still-missing description and photo ([Data Model](./data-model.md) §Normative rules).
Extracts are CC BY-SA and the place card credits them with a link to the article
(`wikipediaUrl`); thumbnails are used only when Wikimedia-hosted — the standing wikimedia-only
image rule. The call is best-effort and silent: offline or failing, nothing queues and nothing
changes.

## Privacy

Each provider observes exactly one slice of activity:

- tile servers see requested tile coordinates and network metadata;
- the geocoder sees typed search text and, during the import ladder, a row's Title and Address;
- Wikipedia sees only the article title an OSM element itself names — never search text, place
  names, or anything the user wrote;
- the share service sees the documents the owner explicitly publishes
  ([Sharing & Publishing](./sharing.md)).

Nothing else leaves the device. Post bodies and list names never go to map or search providers.

## Licensing and attribution

OSM data is ODbL. Linked **© OpenStreetMap contributors** attribution appears wherever
OSM-derived facts appear: on the map canvas, on public list and post pages, and in exports —
exports attribute OSM (ODbL) exactly when `osmRef` is present ([Import & Export](./interop.md)).
Corrections flow upstream, not in-app: the place card links to the element's openstreetmap.org
page whenever `osmRef` exists. Google-derived facts never pre-fill anything sent to OSM.
