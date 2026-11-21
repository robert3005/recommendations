# Vision & Scope

## The problem

People collect places constantly — a café a friend recommended, a hike to try, a restaurant
worth a detour. Today those collections live in vendor-locked saved lists, screenshots, and
notes apps: hard to curate, hard to write about, and awkward to hand to a friend as anything
better than a screenshot. The places are yours; the lists holding them are not.

## The thesis

Placemarks is a **personal atlas**: your places, your lists, your posts, on your own map.
Import the places you have already saved elsewhere, curate them into marked lists, write posts
about the places and lists, and publish any list or post as a read-only page. Everything is
edited locally; publishing is the only remote act.

Import is the front door because the collections already exist — overwhelmingly in Google Maps.
Nobody should have to find every place again through a new map; they should bring the library
they already have and start editorialising it.

## What we're building (v1)

A responsive web app with:

- **Import from Google Maps** — a single place by pasting a map link (Google Maps, Apple Maps,
  or OSM), and whole lists via a Google Takeout archive; My Maps arrives the same way, as
  KML/KMZ. Every source row is accounted for — placed, in review, or explicitly skipped.
  See [Import & Export](./interop.md).
- **Export back out** — each list exports as a custom POI map (KML for Google My Maps, GeoJSON
  for uMap on the OSM side, GPX for the OSM ecosystem's navigation apps) and as per-place deep
  links into Google Maps, Apple Maps, and OpenStreetMap. Apple Maps deliberately gets deep
  links only: it offers no custom-map import, so no export artefact can exist for it.
- **Lists with unique markers** — places collect into named, ordered lists, each wearing a
  unique marker (shape + colour). Membership is existence: a place is in the library exactly
  when it is on at least one list.
- **Posts** — Markdown articles, each about exactly one list or one place. A list post links to
  the place posts of its members, so a list's write-up hands off to its own detail pages.
  See [Posts](./posts.md).
- **The notebook and the map** — every route renders in the notebook beside one persistent map
  canvas. Home opens on the lists and overlays any combination of them on the map, each pin
  wearing its list's marker. See [The Notebook & the Map](./map-view.md).
- **The split post editor** — the Markdown editor beside the canvas projecting the post's
  places; tapping a pin inserts a mention at the cursor.
- **Posts on the list page** — a list displays on the map; its posts are reachable from a
  quiet toggle on the list page, and selecting one opens it split-view with the map.
- **Visual direction** — the quiet paper: off-white chrome beside a light map plate, eight
  bright accents, clean lines, and a small playful layer of pixel labels and pink. See
  [Visual Design](./design.md).
- **Read-only share links** — publish a list or post to a named public page. Nothing leaves the
  device until the owner presses Publish, and the page changes only on an explicit publish
  update. See [Sharing & Publishing](./sharing.md).

## Explicit non-goals (v1)

- No multi-device sync and no accounts. Two devices are two libraries; the library archive
  ([Import & Export](./interop.md)) moves one to the other.
- No social graph or feeds, and no reviews written in the app. Other people's reviews are
  classification input only, never displayed ([Review Insights](./reviews.md)).
- No proprietary API calls and no link scraping. Parsing files the user exported of their own
  data, and URLs the user pastes, is portability; fetching a vendor's pages is not.
- No turn-by-turn navigation or routing.
- No media in posts: posts are text plus places. Place cards show harvested photos with credits
  ([Review Insights](./reviews.md)).
- Two themes only — Paper (light) and Night (dark), following the device setting. No in-app
  theme switch and no custom themes.
- No ambient POI discovery: the map never suggests places; the library grows only when the user
  searches, pastes a link, or imports.

## Futures

Deliberately deferred, one line each:

- Images in posts.
- A dark map plate for the Night theme.
- A native client.
- Collaborative editing of lists and posts.
- Routing.

## Success criteria for v1

- Import a 50-place Google Takeout list and see every row accounted for — placed, in review, or
  explicitly skipped; nothing silently dropped.
- Paste a Google Maps link to a place and have it on a list, wearing that list's marker, in
  seconds.
- Publish a list and a post; a recipient with the link can read both but modify neither.
- On the published page, a list post's link to a place post navigates to that post's public
  page.
- Export the library archive, restore it into an empty library, and every id survives — post
  targets and `place:`/`post:` links intact.
