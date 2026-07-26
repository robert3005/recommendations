# Import & Export

Placemarks meets people where their places already live. Import brings saved places in from
Google Maps — one place via a pasted link, whole lists via Takeout, custom maps via My Maps KML —
and export hands curated lists back out to Google Maps, Apple Maps, and the OSM ecosystem, as
custom POI maps and as deep links. Both directions are explicit, file-shaped, repeatable actions;
neither ever calls a proprietary API.

## Import

### One place via a link

The add-a-place field ([the notebook & the map](./map-view.md)) accepts a pasted Google Maps,
Apple Maps, or OpenStreetMap URL. Parsing is pure string work — the pasted URL is never fetched.
Two parsing judgements worth recording: Google's `!3d`/`!4d` pair (the pin) is preferred over
`@lat,lng` (the camera) because they differ, and a coordinate pair sitting in the name slot is
not a name.

- A **Google or Apple link** yields a place with coordinates, usually a name, and the URL
  retained as `googleUrl`/`appleUrl` — provenance, dedup key, and the deep link back.
- An **OSM element URL** yields an `osmRef` and fetches that element's facts through the
  geocoder's exact `lookup` — the one network call at paste time. Offline it fails politely:
  nothing queues, and the user retries online.
- A **`maps.app.goo.gl` short link** reveals nothing without following a redirect, so the app
  asks for the expanded URL instead; we never fetch.

Every variant ends in "pick a list", because membership is existence
([data model](./data-model.md)).

### Lists via Takeout

A Takeout archive is imported as a whole, because its two halves compensate for each other:

| Source | Format | Fields | Coordinates |
|---|---|---|---|
| Takeout → **Saved** | One CSV per list; the list name is the filename | Title, Note, URL, Address | **No** |
| Takeout → **Maps (your places)** | `Saved Places.json` (GeoJSON) | Title, Google Maps URL, geometry | Usually — `[0, 0]` geometry is treated as absent |

Facts about the CSVs that shape the whole design: **there are no coordinates** — Google exports
the minimum needed to identify a place. The URL column is one of two shapes: a **place URL**
carrying Google's opaque internal feature id (useful as a stable dedup key and as a deep link
back into Google Maps), or, for user-dropped pins, a **search URL embedding literal `lat,lng`** —
free coordinates. `Saved Places.json` has geometry but no list structure; the CSVs have list
structure but no geometry.

Saved Places entries that appear in no CSV import into an auto-created **"Saved places"** list —
membership is existence, so a place with geometry but no list still needs a list to live in. The
auto-created list binds to the GeoJSON filename as its `sourceKey`, so re-imports converge into
it, and the import report accounts for these entries exactly like CSV rows.

### CSV Note → place post

The Note column is the user's own writing. It becomes a **place post** titled with the place's
name ([posts](./posts.md)). The rule is per place, so it needs no import provenance to enforce: a
Note materialises as a place post only when the deduped place has no place post yet; otherwise
the Note is dropped and the import report says so. Re-import therefore never creates a duplicate
and never overwrites a post edited in Placemarks — local edits are canon.

### Google My Maps via KML/KMZ

Custom maps export from My Maps as KML/KMZ, and importing them counts as importing from Google
Maps: folders become lists, and each folder's style colour maps to the nearest of the eight
accent colours when its marker is assigned ([data model](./data-model.md)).

### The coordinate ladder

A CSV row must gain coordinates to become a place. In order:

1. **Literal coordinates** in the source — a dropped-pin URL embedding `lat,lng`.
2. **Cross-reference the archive's GeoJSON** by Google feature id — by id only, never by name.
3. **Geocode** Title + Address through the configured geocoder
   ([map data & providers](./data-sources.md)).

The auto-place rule: a single geocoder result whose normalised name matches the row title and
whose address does not contradict auto-places (recording its `osmRef`); anything else — multiple
candidates, name mismatch, no result — goes to the review queue (candidate picker on the canvas,
manual placement by clicking the map, or skip). A geocoder *error* is not a miss: it pauses the
batch's remaining geocode rung — the batch stays `reviewing` and those rows retry when the
geocoder is back; only genuine empty results fall to review.

### The review queue

Review state is persisted (`ImportBatch` and `ImportItem` — [data model](./data-model.md)), so a
half-reviewed import survives a reload. The queue is a notebook route: the item under review
projects onto the canvas, its candidates rendered as labelled pins. Picking a candidate places
the row with that result's facts and records its `osmRef` — geocoder results are OSM data.
**Manual placement is clicking the map**: it yields user-provided coordinates and no `osmRef`.
A row can also be skipped; skips appear in the report.

### Source-list binding and re-import

The first import sets `List.sourceKey` (the CSV filename or KML folder id), so re-imports follow
the binding through local renames — "Google favourites" keeps flowing into the list the user
renamed. Absent a binding, lists match by name.

Re-importing the same or a newer archive converges instead of duplicating. Dedup follows the
normative precedence everywhere: Google feature id (parsed from `googleUrl`) → `osmRef` → name +
coordinate proximity, which prompts the user rather than merging silently. Re-import adds what is
new and never deletes — the user's edits are canon.

### The import report

Every import ends with a report in which every source row and every Saved Places entry is
accounted for: placed, in review, or skipped. No silent drops — truncating rows silently would
poison trust in the front door.

### Explicit non-goals

- **No Google API calls, ever** — no Places API, no geocoding through Google. Importing is
  parsing files the user exported of their own data: portability, not integration.
- **No fetching pasted URLs.** Link paste reads the string and nothing more.
- **No shared-list scraping.** Pasting a Google *list* link will not import it: that would
  require scraping Google's app markup. A link to a *single place* is different and is
  supported, because the URL string itself carries the coordinates. The supported answer for
  lists is "run Takeout, drop the archive here."
- **No live two-way sync with Google Maps.** Import and export stay explicit, file-shaped,
  repeatable actions.

## Export

Every list exports as two artefact kinds: a **custom POI map** and **deep links**.

| Target | Custom POI map | Deep links |
|---|---|---|
| Google Maps | KML/KMZ download + guided My Maps import (2,000 features/layer, 5 MB — warn and split) | per-place: retained `googleUrl`, else coordinate/name search URL |
| Apple Maps | **none exists** — Apple Maps has no custom-map import, so per-place deep links are deliberately the whole Apple answer ([Vision & Scope](./vision.md)) | per-place `maps.apple.com` URL |
| OSM | GeoJSON (or KML) into **uMap** (umap.openstreetmap.fr) — guided | per-place OSM element URL when `osmRef`, else an osm.org `?mlat&mlon` map link |

- **Marker styling travels.** KML `Style` elements and GeoJSON simplestyle properties carry each
  list's marker colour, and the shape name rides as a property where the format allows.
- **GPX waypoints** serve the OSM target's navigation apps: OsmAnd and Organic Maps both ingest
  GPX, so a list rides along on the devices that navigate with OSM data.
- **The deep-link text list** (Markdown) renders the list as prose — name, address, and all
  three deep links per place — the artefact to paste into a message.

One module builds and parses all deep links, so the place card, the exports, and the public
viewer hand out the same URLs ([architecture](./architecture.md)).

### The library archive

The library archive is the backup and migration format — and the answer to IndexedDB eviction,
if exported beforehand ([local storage](./storage.md)). It is one JSON file of the whole
library — places, lists, entries, posts, and publication records (slugs included; they are
public anyway) — **preserving all entity ids**, so `place:`/`post:` links and post targets
survive restore.

- Editor tokens are excluded unless the user explicitly opts in at export ("include publish
  credentials", off by default); the file then contains secrets and its name says so.
- Restore into an empty library is the supported path. Restoring into a non-empty library
  merges by id — same id = same entity, newer `updatedAt` wins. The id-less dedup ladder
  applies only to foreign imports. The merge re-establishes the repository invariants: an
  incoming list whose marker pair is already worn by a different live list is reassigned to the
  first free pair (badged variant beyond 64), and two entries for the same `(listId, placeId)`
  collapse to the one that sorts first by `(rank, id)`.
- A restore without credentials sees its publications but cannot update or revoke them
  ([sharing & publishing](./sharing.md)).

### Licensing

Two one-way valves, stated bluntly because getting either wrong poisons an upstream:

1. **Google-derived facts never flow into OSM.** Imported names, addresses, and coordinates
   never pre-fill anything sent to OSM. The place card links out to the OSM element page when
   `osmRef` exists; corrections happen there, from the user's own knowledge.
2. **OSM-derived facts carry ODbL attribution out.** Exports attribute OSM (ODbL) exactly when
   `osmRef` is present: KML and GeoJSON embed the attribution in metadata; the text list
   carries it as a footer line.

## Testing

Parser fixtures use real-shaped Takeout archives — CSV quoting edge cases, Unicode list names,
dropped-pin URLs beside place URLs, the `[0, 0]` GeoJSON bug — plus KML with folders and styles.
The hand-written KML/GeoJSON/GPX/text writers are asserted against golden snapshots. MSW geocoder
fixtures drive each ladder rung: auto-place, ambiguous → review, no result → manual placement.
An end-to-end test imports a fixture archive, resolves the review queue, then re-imports the same
archive and asserts convergence — the idempotence contract.
