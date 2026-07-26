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

- `search(text, bias?)` — forward geocoding via a Photon-class autocomplete endpoint. Serves the
  add-a-place field and the Title + Address step of the import coordinate ladder
  ([Import & Export](./interop.md)).
- `lookup(osmRef)` — exact element fetch via a Nominatim `/lookup`-class endpoint or the OSM API.
  Serves OSM element URL paste.

Geocoder results are OSM data: any place created or placed from one (a search pick, ladder
auto-placement, a review-queue candidate pick) records the result's `osmRef`
([Data Model](./data-model.md)). The adapter owns debouncing, cancellation, result normalisation,
and retry; callers see plain candidate lists.

Public endpoints such as photon.komoot.io and nominatim.openstreetmap.org carry strict usage
policies and are development-only configurations. Production configuration is explicit and fails
closed: a production build with either capability unconfigured refuses to run against public
defaults.

## Privacy

Each provider observes exactly one slice of activity:

- tile servers see requested tile coordinates and network metadata;
- the geocoder sees typed search text and, during the import ladder, a row's Title and Address;
- the share service sees the documents the owner explicitly publishes
  ([Sharing & Publishing](./sharing.md)).

Nothing else leaves the device. Post bodies and list names never go to map or search providers.

## Licensing and attribution

OSM data is ODbL. Linked **© OpenStreetMap contributors** attribution appears wherever
OSM-derived facts appear: on the map canvas, on public list and post pages, and in exports —
exports attribute OSM (ODbL) exactly when `osmRef` is present ([Import & Export](./interop.md)).
Corrections flow upstream, not in-app: the place card links to the element's openstreetmap.org
page whenever `osmRef` exists. Google-derived facts never pre-fill anything sent to OSM.
