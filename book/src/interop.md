# Import & Export — Interop

> **Implementation decisions (2026-07-19, hardening wave).**
>
> - KML: a StyleMap resolves through its *normal* pair regardless of declaration order, and loose
>   document-level placemarks keep their own style beside styled folders. GeoJSON re-imports use
>   the FeatureCollection's own `name` (not the download filename) and round-trip `website`.
> - A Google Maps listing URL is the identity and deep-link ref wherever it appears in a row's
>   URL list — generic web provenance never outranks it (dedup, navigation, CSV URL column).
> - Geocode auto-linking additionally requires a non-contradicting category (a cafe row never
>   auto-links to a school); contradictions go to review, where ambiguous candidates render on a
>   labelled mini map beside the picker.
> - ODbL continuity: manually placing a review row that descends from an OSM anchor records the
>   anchor as (unresolved) link history, so re-exports keep attributing OSM-derived facts.
> - Exports fail closed when owned notes cannot be read, and My Maps handoffs split on whichever
>   binds first: 2,000 features per layer or 5 MB per file.

**Decision (2026-07-18).** Living with the Phase 0–2 build sharpened the thesis: Placemarks is
**a way to editorialise lists of places**. The places people care about are already collected —
overwhelmingly in Google Maps. OSM data and search quality trail Google's in many regions, and
closing that gap is not our fight; making users *find everything again* through our OSM search
would kill the product at the front door. So:

1. **Import is the primary way places enter Placemarks.** Google Maps first (Takeout), then the
   file formats the rest of the ecosystem speaks (KML/KMZ, GPX, GeoJSON).
2. **Our UI is the editorial layer**: adjust the list — order, membership, markers, notes,
   sections — and read it, on the map, for navigation.
3. **Export and deep links hand back to the tools people actually navigate with.** We are not
   trying to replace Google Maps as a navigator; we link out to it per place and export whole
   lists it (and others) can ingest.

OSM remains the open substrate — the basemap, the durable-identity anchor, and the enrichment
source (website, hours) — but it is no longer the gatekeeper of existence. A place can live a full
life in Placemarks linked only to the user's imported facts, exactly as manual pins already do.

## What we import

| Source | Format | Fields | Coordinates |
|---|---|---|---|
| Google Takeout → **Saved** | One CSV per list; list name is the filename | Title, Note, URL, Address | **No** |
| Google Takeout → **Maps (your places)** | `Saved Places.json` (GeoJSON) | Title, Google Maps URL, geometry | Usually — with a known `[0, 0]` bug |
| Google My Maps, Organic Maps, others | KML / KMZ | Name, description, folders, styling | Yes |
| OsmAnd, Garmin, hiking apps | GPX waypoints | Name, description | Yes |
| Anything modern | GeoJSON | Free-form properties | Yes |

Facts about the Takeout CSVs that shape the whole design:

- **There are no coordinates.** Google exports the minimum needed to *identify* a place: a name,
  an address, and a Google Maps URL.
- The URL is one of two shapes: a **place URL** carrying Google's internal feature id (an opaque
  hex pair — useful only as a stable dedup key and as a deep link back into Google Maps), or, for
  user-dropped pins, a **search URL that embeds literal `lat,lng`** — free coordinates.
- The Note column is the user's own writing and imports losslessly.
- `Saved Places.json` covers starred/default saves with geometry, but not custom list structure;
  the CSVs have the list structure but no geometry. A Takeout archive is imported as a whole so
  each source compensates for the other.

### Explicit non-goals

- ❌ **No Google API calls, ever** — no Places API, no geocoding through Google, no fetching a
  Google URL to scrape coordinates. The proprietary-API ban ([vision](./vision.md)) stands.
  Importing is *parsing files the user exported of their own data* — portability, not
  integration.
- ❌ **No shared-link scraping.** Pasting a `maps.app.goo.gl` list link will not import it:
  it requires scraping Google's app markup, which is fragile and against terms. The supported
  answer is "run Takeout, drop the archive here."
- ❌ **No live two-way sync with Google Maps.** Import and export are explicit, file-shaped,
  repeatable actions.

## Import pipeline

```text
archive/file → detect → parse → ImportItems → place (coords ladder) → match OSM (optional)
                                                      │                        │
                                                      ▼                        ▼
                                              review queue  ──────▶  materialize into lists
```

**Detect & parse.** Accept a whole Takeout `.zip` (fflate, same dependency as backups), a single
CSV, KML/KMZ, GPX, or GeoJSON. Each parsed row/placemark becomes an `ImportItem`; each source
list (CSV file, KML folder) proposes a `List`.

**Place — the coordinate ladder.** An item must have coordinates to become a place (places are
pins; the map is the product). In order:

1. **Literal coordinates** in the source (KML/GPX/GeoJSON geometry, dropped-pin URLs,
   `Saved Places.json` geometry that isn't `[0, 0]`). Done.
2. **Cross-reference within the import**: the same place appearing in both a CSV (structure) and
   `Saved Places.json` (geometry) is joined by its Google URL id — by id only, never by name.
3. **Geocode** Title + Address through our configured geocoding adapter (Photon/Nominatim family —
   [data sources](./data-sources.md); public endpoints remain development-only). Candidates are
   scored with the existing evidence ladder from
   [Durable Place Identity](./place-identity.md) — name similarity, address, category; distance
   alone never qualifies:
   - a unique high-confidence candidate → **auto-placed** (and OSM-linked for free, since the
     geocoder returned an OSM element);
   - plausible-but-ambiguous candidates → **review queue** with a mini map + candidate picker;
   - nothing usable → **review queue** for manual placement on the map, or skip.

**Match OSM — opportunistic, never blocking.** OSM linkage is an upgrade exactly as it is for
manual pins, not an import gate. An item placed with coordinates but no confident OSM match
becomes an **`unlinked` place with imported facts** — the manual-pin machinery, with provenance
recorded. It can be linked later through the same candidate picker.

**Materialize.** Import goes through the one door that exists
([membership is existence](./data-model.md#membership-is-existence-no-saves)):

- each source list becomes a `List` (marker colour auto-assigned from the palette; name from the
  filename/folder, deduplicated);
- each placed item enters via `addToList` — the import *is* the adding-to-a-list;
- the CSV Note column becomes a place note (plain text imported as a Markdown paragraph);
- the Google Maps URL is retained as an **external ref** on the place — provenance and the best
  deep link back into Google Maps
  ([data model](./data-model.md#place-identity-and-osm-binding)).

**Idempotent re-import.** Running the same (or a newer) Takeout again converges instead of
duplicating: items dedup first by external-ref id (the Google URL's feature id), then by
name + coordinate proximity against existing places — reusing the cross-list dedup that
`addToList` already performs for OSM refs. Re-import adds what's new and touches nothing else; it
never deletes (the user's edits in Placemarks are the canon after import).

**No silent drops.** The import ends with a report: *n* placed automatically, *n* OSM-linked,
*n* waiting in review, *n* skipped — every source row accounted for. Truncating or dropping rows
silently would poison trust in the front door.

### Import queue model

Review state is persisted so a half-reviewed import survives a reload; the queue is workflow
state, not part of the durable place graph.

```ts
interface ImportBatch {
  id: string;
  source: "google-takeout" | "csv" | "kml" | "gpx" | "geojson";
  fileName: string;
  startedAt: string;
  status: "reviewing" | "done" | "abandoned";
}

interface ImportItem {
  id: string;
  batchId: string;
  targetListId: string;
  raw: { title: string; note?: string; url?: string; address?: string };
  coords?: { lat: number; lng: number };
  candidates?: OsmCandidate[];          // scored, when geocoding ran
  status: "placed" | "review" | "skipped";
  placeId?: PlaceId;                    // set once materialized
}
```

## Export

Every list exports to the formats the ecosystem ingests. Fidelity varies and is stated in the UI:

| Format | Carries | Consumed by | Notes |
|---|---|---|---|
| **KML / KMZ** | names, coords, descriptions (notes), list as document, marker colours as styles | Google My Maps, Organic Maps, Google Earth, OsmAnd | My Maps limits: 2,000 features/layer, 5 MB KML — we warn and split |
| **CSV** (Takeout-shaped) | Title, Note, URL, Address | spreadsheets; round-trips into our own importer | URL column: retained Google external ref, else OSM portal URL, else a `lat,lng` maps search URL |
| **GeoJSON** | everything portable: coords, names, notes, tags, external refs as properties | web GIS tools, other apps | the interchange format; our ZIP backup remains the full-fidelity archive |
| **GPX** | waypoints: name, description | OsmAnd, Garmin, hiking watches | |

- **"Send to Google My Maps"** is a KML download plus a short guided instruction ("My Maps →
  Import → choose this file") — there is no write API, and pretending otherwise would mean
  scraping. Within its limits this gives users their editorialised list *inside* Google's
  ecosystem.
- **Attribution travels with exports.** Any export containing OSM-derived facts carries
  ODbL attribution metadata ([licensing](./data-sources.md#licensing-and-attribution)).
  User-authored notes and user-imported facts are the user's own data. *(2026-07-19: the CSV
  gained a fifth `Attribution` column for this — the four Takeout columns stay first, so
  Takeout-shaped parsers, ours included, still round-trip it. CSV cells are formula-escaped.)*

### Implementation decisions (2026-07-19, recorded with the Phase 3 hardening round)

- **KML folders become separate lists**, keeping their `Style` marker colours; a folderless
  document stays one list.
- **Coordinate-bearing rows opportunistically OSM-link** through a tight nearby search judged by
  the conservative identity ladder — one unique high-confidence candidate links, anything else
  imports unlinked. Auto-linking via the geocoder additionally requires a non-contradicting
  address, and a failed exact-resolve never places a row at bare geocoder coordinates (it stays
  in review — OSM-derived coordinates without evidence would dodge attribution).
- **Source-list identity survives renames**: the first import binds the source name to the local
  list; re-imports follow the binding, so "Google favourites" keeps flowing into the list the
  user renamed "My edited Lisbon list".
- **GeoJSON is the full-fidelity interchange**: it carries phone, hours, tags, notes, OSM refs
  (which re-imports resolve exactly — never geocoded, never mislabeled as Google provenance),
  and external URLs.

## Navigation handoff — deep links

Placemarks curates; navigation happens wherever the user prefers. The place card offers:

- **Open in Google Maps** — the retained external-ref URL when the place was imported (it
  reopens the *exact* Google listing), otherwise a universal maps search URL built from
  coordinates and name.
- **Open in Apple Maps** — the equivalent `maps.apple.com` link.
- **View on OpenStreetMap** — the existing portal link, when OSM-linked.

Turn-by-turn routing stays a non-goal; deep links *are* the navigation story.

## List curation returns (edit mode)

Imported lists arrive with 30–200 places; curating them one place-card at a time does not scale.
The 2026-07-18 interop decision brings list editing back as a **deliberate Edit mode on the list
page** — reorder, remove, rename, recolour — while the default list view stays read-only for
reading and navigation. This supersedes the earlier "no edit functionality on the Lists tab"
ruling *for the edit mode only*, and is the first slice of the guide editing surface (guides are
editorialised lists — sections and prose land on the same blocks later).

## Licensing hygiene

Two one-way valves, stated bluntly because getting them wrong poisons either upstream:

1. **Google-derived facts never flow into OSM.** Imported names/addresses/coordinates must not
   pre-fill any "Add it on OpenStreetMap" handoff or OSM edit. The existing rule ("never copy
   data from a proprietary places service" — [data sources](./data-sources.md)) applies with
   extra force now that Google-sourced fields live in the database. Users contribute to OSM from
   their own knowledge, not from our stored Google data.
2. **OSM-derived facts carry ODbL attribution out.** Exports state which fields are OSM
   observations; user-authored and user-imported content is technically distinguishable
   ([data model](./data-model.md)) so this split is mechanical, not archaeological.

## Testing

- **Parser fixtures**: real-shaped Takeout archives (CSV quoting edge cases, Unicode list names,
  dropped-pin URLs vs place URLs, the `[0, 0]` GeoJSON bug), KML with folders/styles, GPX
  waypoints. Property tests for the CSV/KML/GPX parsers.
- **Matching**: MSW geocoder fixtures driving each ladder rung — auto-place, ambiguous → review,
  no-match → manual placement; idempotent re-import converging on the same library.
- **e2e**: import a fixture Takeout ZIP → resolve the review queue → lists on the map wearing
  their markers → export KML → re-import converges. Export files are asserted against golden
  snapshots.
