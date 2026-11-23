# Map Data & Providers

Placemarks reads geographic facts from OpenStreetMap first, and from other place sources where
OSM has a gap, and stores the user's own copy of those facts on their places. It builds no second
public POI database. The one test a search provider must pass is the **keep-and-show rule**: its
terms let a saved place's name, position and address be kept for good and drawn on our own map.
Open datasets pass by licence (OSM, Foursquare OS Places, Overture); a hosted provider passes on
a plan that permits permanent storage. Providers whose terms forbid either — Google Places, HERE
and TomTom at the time of writing — stay out for that reason alone.

Pasted Google and Apple Maps URLs are parsed locally. Two pastes make a network call: an OSM
element URL (the geocoder `lookup(osmRef)`), and a `maps.app.goo.gl` short link, whose redirect
the share service follows to learn the full URL — never a page ([Import & Export](./interop.md)).
Both fail politely offline (nothing queues; retry online). Google Maps reviews are downloaded
only by the local harvester, outside the web app, as private input for classification
([Review Harvest](./harvest.md)).

## Map tiles

MapLibre GL JS renders OSM-derived vector tiles — crisp zoom, rotation, and runtime styling.
The basemap is **our own plate**: a MapLibre style built in code (`src/map/basemapStyle.ts`) with
`@protomaps/basemaps`, recoloured to the neutral, desaturated light palette of
[Visual Design](./design.md) so accent pins are the loudest thing on the canvas. POI icons and
road shields are dropped — the only points of interest on the map are the user's own places.
The linked OSM attribution control is always visible.

Production reads one Protomaps-schema **PMTiles** archive kept in static storage (Cloudflare R2)
through a small tile service (`services/tiles`, a Cloudflare Worker): it serves each tile at its
own URL (`/<archive>/<z>/<x>/<y>.mvt`) with long cache lifetimes, so browsers reuse tiles across
visits and Cloudflare's edge can serve them without touching the archive. Range requests into one
large file were never reused that way. The plate's glyphs and sprite come through the same
Worker: `VITE_MAP_TILES_URL`, `VITE_MAP_GLYPHS_URL`, `VITE_MAP_SPRITE_URL`. No per-view metering,
no tile vendor in the request path. `VITE_MAP_PMTILES_URL` still reads an archive directly by
range request, which is the fully offline development option. A production build fails closed
when the plate's assets point at development hosts.

Without a PMTiles archive, `VITE_MAP_STYLE_URL` selects a hosted style instead. Development
defaults to OpenFreeMap Positron (keyless); VersaTiles, Stadia Maps on localhost, or MapLibre
demotiles serve smoke tests, while e2e keeps a local style fixture. Application overlays depend
on no basemap layer schema, so switching providers is a configuration change.

## Geocoder

One adapter, two calls, possibly two endpoints:

- `search(text, bias?)` — forward geocoding via a Photon-class **or** Pelias-class autocomplete
  endpoint, selected by `VITE_GEOCODER` (`photon` is the keyless development default; `pelias`
  requires `VITE_PELIAS_URL`, with an optional `VITE_PELIAS_KEY` sent as a query parameter).
  Serves the search field and the Title + Address step of the import coordinate ladder
  ([Import & Export](./interop.md)).
- `lookup(osmRef)` — exact element fetch via a Nominatim `/lookup`-class endpoint or the OSM API.
  Serves OSM element URL paste.

A search candidate records the result's `osmRef` whenever the upstream sources it from OSM
([Data Model](./data-model.md)); Photon-class results always do. Pelias-class results may come
from other sources (OpenAddresses, Who's on First, Foursquare OS Places) and then carry no
`osmRef` — such a pick behaves like manual placement: no ODbL attribution claim, no OSM element
link. `VITE_PELIAS_SOURCES` optionally names the upstream sources to search, for a provider whose
extra venue data is opt-in.

Pelias-class endpoints are Stadia Maps (`https://api.stadiamaps.com/geocoding`, OSM plus
Foursquare OS Places venues; keyless on localhost, and permanent storage of results needs its
Standard plan), geocode.earth, and a self-hosted Pelias. Geoapify has its own API shape and would
need its own adapter. The adapter owns
debouncing, cancellation, result normalisation, and retry; callers see plain candidate lists.

Public endpoints such as photon.komoot.io and nominatim.openstreetmap.org carry strict usage
policies and are development-only configurations. Production configuration is explicit and fails
closed with either geocoder kind: a production build with any capability unconfigured refuses to
run against public defaults. A personal test deployment counts as a development configuration:
building with `PLACEMARKS_TEST_DEPLOY=1` lets search and lookup point at the public demo
geocoders, at development volumes. The basemap never qualifies.

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
  ([Sharing & Publishing](./sharing.md)), and each short link pasted for expansion;
- Google sees one request per pasted short link, from the share service — not from the device,
  and carrying nothing but the link itself;
- Google sees the harvester's anonymous browsing of the places and searches the owner asks it to
  fetch, from the owner's machine ([Review Harvest](./harvest.md)).

Nothing else leaves the device. Post bodies and list names never go to map or search providers.

## Licensing and attribution

OSM data is ODbL. Linked **© OpenStreetMap contributors** attribution appears wherever
OSM-derived facts appear: on the map canvas, on public list and post pages, and in exports —
exports attribute OSM (ODbL) exactly when `osmRef` is present ([Import & Export](./interop.md)).
Corrections flow upstream, not in-app: the place card links to the element's openstreetmap.org
page whenever `osmRef` exists. Google-derived facts never pre-fill anything sent to OSM.

A place picked from a non-OSM source carries no `osmRef` and so no ODbL claim. Foursquare OS
Places is Apache 2.0 and Overture places are CDLA Permissive 2.0 or Apache 2.0 by source: both
allow keeping and republishing the facts. A hosted provider's own attribution line, where its
terms require one, sits with the search results it produced.
