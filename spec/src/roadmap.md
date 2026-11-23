# Roadmap

The roadmap is an order of build, not a schedule. Each phase ends with a usable, testable
increment of the product described in [Vision & scope](./vision.md); its **Done when** line is
the acceptance check a person can run against the app before the next phase starts.

## Phase 0 — Foundations

- pnpm workspace, strict TypeScript, and the app scaffold ([Tech stack](./tech-stack.md)).
- The notebook + canvas shell: every route renders in the notebook beside the one persistent
  map canvas ([The notebook & the map](./map-view.md)).
- Hosted OSM-derived vector tiles with attribution always visible
  ([Map data & providers](./data-sources.md)).
- App-shell service worker: the app loads offline; nothing more.
- The test harness from the start: Vitest, Playwright, MSW, Storybook.
- Provider fail-closed configuration: public endpoints are development-only.

**Done when** the shell loads offline, the map renders online with visible attribution, and an
unconfigured production provider produces a designed failure state rather than a blank screen.

## Phase 1 — Places & lists

- The search field: type to search, or paste a Google Maps / Apple Maps / OSM link; both
  paths end in one press of Save place ([Import & export](./interop.md)).
- The place card, with deep links out to Google Maps, Apple Maps, and OpenStreetMap.
- Lists with unique markers (shape + colour), entries, and list edit mode: reorder, rename,
  remove entries, change marker.
- The home overlay: every list's places on the canvas, each pin wearing its list's marker,
  with per-list toggles.
- The teardown refusals: deleting a place or a list with posts targeting it is refused with
  the blockers named ([Local storage](./storage.md)).

**Done when** I can search for a café or paste a map link, put the place in a list wearing a
unique marker, overlay all my lists on the home canvas and toggle one off, and open the place
in any of the three external maps from its card.

## Phase 2 — Takeout import

- Archive parsing — per-list CSVs plus `Saved Places.json` — entirely local.
- The coordinate ladder and the auto-place rule for coordinate-less rows.
- The review queue on the canvas: candidate picker, manual placement by clicking the map, skip.
- The auto-created "Saved places" list for entries appearing in no CSV.
- The import report: every source row and Saved Places entry accounted for.
- Source-list binding and idempotent re-import: re-import adds what is new and never deletes.
- Google My Maps import via KML/KMZ: folders become lists, styles map to the nearest accent.
- The Post entity exists from this phase — CSV Notes materialise as place posts; the post
  authoring and reading UI lands in Phase 4 ([Posts](./posts.md)).

**Done when** a real Takeout archive imports with every row placed, in review, or skipped and
none silently dropped, CSV Notes are stored as place posts, and re-importing the same archive
changes nothing.

## Phase 3 — Export

- KML/KMZ with a guided Google My Maps handoff, warning and splitting at the feature/size caps.
- GeoJSON with a guided uMap handoff; GPX waypoints for OsmAnd and Organic Maps.
- The deep-link text list: the list as Markdown prose, all three deep links per place.
- The library archive: one id-preserving JSON file of the whole library; restore into an empty
  library; publish credentials excluded unless explicitly opted in.
- ODbL attribution embedded in every export carrying OSM-derived facts.

**Done when** an exported KML opens in Google My Maps with the list's marker colour intact, and
a library archive exported, wiped, and restored preserves every entity id so post targets and
`place:`/`post:` links still resolve.

## Phase 4 — Posts

- Authoring entry points: **New post** in the list page's posts sidebar, **Write a post** on
  the place card.
- The split editor: Markdown in the notebook beside the canvas projecting the post's places;
  tapping a pin inserts a mention; the post-link picker inserts `post:` links.
- The reading view: article beside the projection, mention ↔ pin selection in both directions,
  camera flights (instant under reduced motion).
- The posts sidebar on the list page; selecting a post opens its reading view.
- Cross-post links, so a list post links to its places' posts.

**Done when** I can write a post about a list in the split editor, insert mentions by tapping
pins, link a member's place post, and read the result beside the map with a mention selection
flying the camera to its place.

## Phase 5 — Publish & share

- The share service and its full protocol ([Sharing & publishing](./sharing.md)).
- Per-publication editor tokens, generated at first publish, held on the Publication row.
- Explicit publish, update, and unpublish as foreground actions, with a preview showing
  exactly what leaves the device.
- The publish-time link rewrite, and the preflight that offers to publish
  linked-but-unpublished posts alongside.
- The public viewer: `/l/<slug>` and `/p/<slug>` render read-only in the same notebook + map
  shell.
- The publication teardown refusal: deleting a published list or post is refused until it is
  unpublished.

**Done when** publishing a list yields a link anyone can read but no one can edit, the public
page changes only when I press Publish again, Unpublish revokes it, and deleting a published
target is refused until I unpublish it first.

## Phase 6 — Visual system & hardening

- The visual polish pass: paper-and-ink surfaces, the eight accents, the marker system,
  the neutral basemap ([Visual design](./design.md)).
- Accessibility acceptance: keyboard operability, dialog semantics for sheets, reduced motion.
- Performance: marker clustering at scale and large-import responsiveness.
- Abuse and takedown operations for the share service.

**Done when** the app reads as one designed instrument — bright accents on quiet paper — passes
the keyboard and reduced-motion acceptance checks, and stays responsive with a
several-thousand-place library on the canvas.

## Phase 7 — The library

- Places independent of lists: one-press save, explicit delete, lists that delete without
  being emptied ([Data model](./data-model.md) §The library).
- The personal layer on the place card: free-text tags, a note, a rating, been / want to go —
  own tags drawn apart from review-derived tags ([Visual design](./design.md) §Tags).
- The library home: every place, facet filters, saved views
  ([The notebook & the map](./map-view.md) §Home).
- One search field: saved places first, the wider map second, leaning toward the canvas.
- Layers: every list and saved view a named, toggleable layer; place names on pins; clusters
  that open for good at neighbourhood zoom.
- Phone, tablet and desktop: search first on a phone, editing and import with room on a big
  screen, the place card taking the notebook's column on a tablet.
- Live, versioned share pages carrying the curator's voice
  ([Sharing & publishing](./sharing.md)).
- Import that places rows on evidence ([Import & export](./interop.md) §The coordinate ladder).

**Done when** I can save a place without choosing a list, tag and rate it, find it again by a
tag or a word from my note on a phone, see two lists and a saved view on the map at once with
their names, and share a list whose page shows my intro and notes and updates itself after I
edit it.

## Cross-cutting from day one

- Attribution and licensing on every surface: the canvas always shows tile attribution, and
  exports carrying OSM-derived facts (`osmRef` present) embed ODbL attribution.
- Public links are read-only; the editor token never appears in a URL or a document.
- Provider budgets and fail-closed configuration: public endpoints are development-only, and
  production fails closed when a capability is unconfigured.
- The local repository is primary; every network effect — geocoding, tiles, publishing — is
  explicit and foreground, and nothing queues behind the user's back.
