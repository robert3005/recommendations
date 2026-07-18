# Vision & Scope

## The problem

People collect places constantly — a café a friend recommended, a hike to try, a restaurant
worth a detour. Today that lives in screenshots, notes apps, and Google Maps "saved" lists that
are locked into one vendor and awkward to share. We want a **personal, open, portable** way to
curate places and hand a friend a link.

**Sharpened thesis (2026-07-18, after living with the first build):** Placemarks is **a way to
editorialise lists of places**. The collections already exist — overwhelmingly in Google Maps —
and OSM data/search quality trails Google's in many regions, so finding every place again through
our own map cannot be the front door. Instead: **import from the tools people actually use**,
make our UI the place where a list is adjusted and read for navigation, and hand navigation back
out through deep links and exports ([Import & Export](./interop.md)).

## What we're building (v1)

A responsive web app with:

- A **map view** as the home screen — pan/zoom, current location, search.
- **Place lookup** — tap a pin or search to see a place's name, category, address, and (when
  available) **website**, hours, and phone, sourced from OSM.
- **Durable places & tagging** — a place enters the library by being **added to a list** (there
  is no standalone save): an existing OSM POI resolves under an app-owned identity with bounded
  copied evidence, then carries free-form tags and personal notes. **Membership is existence** —
  a place removed from its last list is gone.
- **Lists first** (flow inverted 2026-07-18) — group saved places into named **lists**. A list
  is a name plus a **user-selected marker colour** over an ordered set of places: created and
  populated **from a place's card** ("add to new list" — and adding to a list *is* the save),
  read on the **read-only Lists tab**. Its places wear the marker on the map. **Guides come
  later as editorialised lists** — the same list enriched with prose, interleaved Markdown
  sections, and a reading experience. Descriptive text belongs to the guide layer, not the
  list.
- **Google Maps import & export** (2026-07-18) — a Google Takeout archive (per-list CSVs +
  saved-places GeoJSON), KML/KMZ, GPX, or GeoJSON imports into lists through a review queue;
  lists export as KML (Google My Maps ingests it), Takeout-shaped CSV, GeoJSON, and GPX. Each
  imported place keeps its Google URL as an external ref — provenance and a **deep link** for
  navigation handoff (Google/Apple Maps). See [Import & Export](./interop.md).
- **Shareable lists** — publish a guide to a persistent, **read-only public link**. Only the creator
  can update/unpublish it using a separate private editor bearer token. It shows the latest successfully
  published guide revision and the latest OSM facts the viewer can resolve.
- **Local-first storage** — saved data and editing work without an account and, after the app shell
  loads, without a network. Search, uncached maps, OSM refresh, uploads, and publishing are online
  capabilities.
- **Upstream corrections** — view/edit an existing POI on OpenStreetMap, or add a missing POI there
  and return to link it after OSM-derived services update.
- **Unlinked manual pins** — drop a clearly-labeled local pin for spots that aren't in OSM (or
  shouldn't be: a picnic bench, a meeting point). Works offline; upgradeable to an OSM link later
  via the candidate picker.

## Explicit non-goals (v1)

- ❌ No reviews, ratings aggregation, or user-generated content beyond your own notes/tags.
- ❌ No social graph, following, or feeds.
- ❌ No proprietary places API **calls** (Google/Foursquare/Yelp). OSM is the only live
  geographic source. Parsing files the user exported of their own data (Takeout, KML, GPX) is
  portability, not integration — in scope; scraping Google share links is not.
- ❌ No turn-by-turn navigation or routing (may come later; out of scope now).
- ❌ No heavy "places enrichment" pipeline. If OSM has a website tag, great; if not, we don't
  go hunting for one or publish an app-wide correction overlay.
- ❌ No automatic identity guessing. An unlinked manual pin stays clearly labeled as not linked to
  OSM until the owner confirms a link; a retained OSM place may enter `missing` state if its
  element disappears and no replacement resolves.

## Who it's for

- The **traveler** building a trip shortlist.
- The **local** keeping a living map of favorites.
- The **recommender** who wants to send a curated list as one clean link.

## Success criteria for v1

- The map is visible and usable within ~2 seconds of launch on a mid-range phone over 4G; denied
  or slow geolocation never blocks first use. (Formal p75/p95 budgets on reference devices are a
  [hardening-phase](./roadmap.md) concern.)
- Find a place and save it with a tag in < 15s.
- Import a 50-place Google Takeout list and see it on the map with every row accounted for —
  placed, in review, or explicitly skipped; nothing silently dropped.
- Create a list, add 5 places, and share a working link in < 1 min.
- A recipient can read but cannot modify a shared guide; its creator can publish an update.
- If an OSM node is replaced by a way/relation, the saved place retains its notes and either
  re-resolves with high confidence or asks the owner to review candidates.
- A month-old link still renders copied evidence and clearly reports whether live OSM refresh
  succeeded, while preserving the latest successfully published guide revision.
