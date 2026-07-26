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

**Second sharpening (2026-07-19, the lists-and-posts pivot):** Placemarks is a **blog platform
with a heavy geolocation focus**. Google Maps import/export is the basic building block the whole
flow centres on; **lists** are the curation primitive built on it — import places, group them
into lists, add notes to places; **posts** — editorialised articles about lists, embedding items
from those lists — are the product's voice ([Posts](./posts.md)); and the map binds every piece
of writing to physical locations. The home screen is the **Lists view**, each list with a
fixed-length inline preview; one collapse away is the **all-lists map**, every point wearing its
list's unique marker on a persistent canvas ([Views](./map-view.md)). The initial version is
**local storage with remote sync**, and both **lists and posts share** as read-only links.

## What we're building (v1)

A responsive web app with:

- **One layout grammar** (2026-07-19, late): every route renders in a **content pane** beside a
  **persistent map canvas** that projects the pane's places — desktop splits them, mobile floats
  the pane as a detented sheet over the map ([Views](./map-view.md#the-grammar)).
- A **Lists home** (2026-07-19) — launch opens the pane expanded on the lists: every list with
  its marker, name, place count, and a **fixed-length, truncated inline preview**; tapping opens
  the list, collapsing the pane is the map.
- The **all-lists canvas** — every library point at once, each wearing its **list's unique
  marker (icon + colour)**; lists toggle on/off as the primary filter. Pan/zoom, current
  location, and search as before.
- **Place lookup** — tap a pin or search to see a place's name, category, address, and (when
  available) **website**, hours, and phone, sourced from OSM.
- **Durable places & tagging** — a place enters the library by being **added to a list** (there
  is no standalone save): an existing OSM POI resolves under an app-owned identity with bounded
  copied evidence, then carries free-form tags and personal notes. **Membership is existence** —
  a place removed from its last list is gone — and **teardown is bottom-up** (2026-07-19): that
  removal is refused until you have deleted the place's notes and embeds yourself; a list
  deletes only once emptied. Nothing you wrote ever disappears as a side effect.
- **Lists first** (flow inverted 2026-07-18) — group places into named **lists**. A list
  is a name plus a **unique marker (icon + colour)** over an ordered set of places: created
  **directly on the Lists tab** (a list may exist before any place joins it — 2026-07-18, late)
  or inline **from a place's card** ("add to new list" — membership is how the place persists).
  Lists are **edited in place** — reorder, remove, rename, remark — and gain members from their
  page or **from the map**. Descriptive prose belongs to posts, not lists.
- **Posts** (2026-07-19) — editorialised articles about lists: interleaved Markdown sections and
  **place embeds** drawn from the author's lists, read as an article beside a synchronized map.
  See [Posts](./posts.md).
- **Google Maps import & export** (2026-07-18) — a Google Takeout archive (per-list CSVs +
  `Saved Places.json` GeoJSON), KML/KMZ, GPX, or GeoJSON imports into lists through a review queue;
  lists export as KML (Google My Maps ingests it), Takeout-shaped CSV, GeoJSON, and GPX. Each
  imported place keeps its Google URL as an external ref — provenance and a **deep link** for
  navigation handoff (Google/Apple Maps). See [Import & Export](./interop.md).
- **Shareable lists & posts** — publish a list or a post to a persistent, **read-only public
  link**. Only the creator can update or unpublish it using a separate private editor bearer
  token. It shows the latest successfully published revision and the latest OSM facts the viewer
  can resolve.
- **Local-first storage with remote sync** (sync promoted into v1, 2026-07-19) — library data and
  editing work without an account and, after the app shell loads, without a network; an optional
  account keeps several devices converged in the background. Search, uncached maps, OSM refresh,
  uploads, publishing, and sync are online capabilities.
- **Upstream corrections** — open an existing POI on the OpenStreetMap portal and edit/report it
  there, or add a missing POI and return to link it after OSM-derived services update.
- **Unlinked manual pins** — drop a clearly-labeled local pin for spots that aren't in OSM (or
  shouldn't be: a picnic bench, a meeting point). Works offline; upgradeable to an OSM link later
  via the candidate picker.

## Explicit non-goals (v1)

- ❌ No reviews, ratings aggregation, or user-generated content beyond your own notes, tags, and
  posts.
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

- Launch opens the **Lists home** within ~2 seconds on a mid-range phone over 4G; one interaction
  switches to the map, where every list's points wear that list's marker. Denied or slow
  geolocation never blocks first use. (Formal p75/p95 budgets on reference devices are a
  [hardening-phase](./roadmap.md) concern.)
- Find a place on the map, add it to a list, and tag it in < 15s.
- Import a 50-place Google Takeout list and see it on the map with every row accounted for —
  placed, in review, or explicitly skipped; nothing silently dropped.
- Create a list, add 5 places, and share a working link in < 1 min.
- Write a post — two prose sections around three place embeds from a list — and publish it as a
  read-only link whose article and map stay in sync.
- A recipient can read but cannot modify a shared list or post; its creator can publish an update.
- A second device signed into the same sync account converges to the same library — lists, posts,
  notes, tags — without silently losing a concurrent edit.
- If an OSM node is replaced by a way/relation, the library place retains its notes and either
  re-resolves with high confidence or asks the owner to review candidates.
- A month-old link still renders copied evidence and clearly reports whether live OSM refresh
  succeeded, while preserving the latest successfully published revision.

## Prior art — Step: Your World

[Step: Your World](https://stepyourworld.com) ("the world's first global culture mapper") is the
closest existing product to what we're building, so it's a useful yardstick — some things to
emulate, several we deliberately do differently.

## What Step is

A native iOS/Android **social** place-mapping app:

- **Save & annotate places** — map out favorite spots worldwide, add photos and comments.
- **Category filters** — the map filters by **eat, drink, shop, stay, culture & health**.
- **Social graph** — follow friends and "Culture Curators" (chefs, designers, writers…). *You
  only see comments and places from people you follow.*
- **Import from anywhere** — paste an **Instagram/TikTok** link, a **Google Maps** link, import
  from **Notes**, or from **screenshots** of saved photos, and it pulls the spots in.
- **Curated city guides** and a premium AWS-Personalize "personalized for you" recommender.

### Their stack (from the build agency case study)

Native **Swift** + **Apollo GraphQL**; **Node.js/Nest.js** backend on **AWS ECS**; **PostgreSQL +
PostGIS** for proximity/bbox/clustering queries; **AWS Personalize** for recs; Firebase/Google
Analytics. Places data source is **not disclosed** (no mention of OSM — most likely a proprietary
provider such as Google Places or Foursquare).

## What we should emulate or improve on

| Step feature | Our take |
|---|---|
| **Import from links / screenshots** | Their standout feature validates import as the front door, but our reliable/legal surface is different: user-exported files first (Google Takeout, KML/KMZ, GPX, GeoJSON). We explicitly reject scraping Google share links; IG/TikTok and screenshot extraction remain experimental futures. See [Import & Export](./interop.md). |
| **Category taxonomy (eat/drink/shop/stay/culture/health)** | Clean and legible; maps well onto OSM tags. We adopt a similar top-level filter set (see [Map View](./map-view.md)). |
| **Photos + comments per place** | We have notes; adding optional **photos** (local blobs first) is a cheap, high-value memory feature. |
| **PostGIS for geo queries** | Validates our optional-backend choice — already our documented path in [Tech Stack](./tech-stack.md). |

## Where we deliberately diverge (our thesis)

These are the design bets that differentiate us — mostly by being *lighter and more open*:

1. **Open live data, portable personal imports.** Step's places data is closed/undisclosed. Our
   live geographic providers are OSM-derived and surface the **website** from OSM tags; files the
   user exported from other tools may coexist as private imported facts. OSM coverage is thinner
   in some places, but source evidence stays portable and attributable. Public corrections go
   upstream to OSM rather than into an app-specific global overlay.
2. **Personal-first, not social-graph-gated.** Step's core loop *requires* following people —
   the map is empty until you build a social graph (a hard cold-start). We work **solo from
   minute one**; discovery via people is an optional later layer, never a prerequisite.
3. **Share by link, not by profile+follow.** Step sharing lives inside the app's social graph.
   Our headline is a **persistent, read-only public link** anyone can open with **no app and no
   account**; its creator updates it with a separate private editor bearer token
   ([Sharing](./sharing.md)).
   This is the single biggest UX improvement we're betting on.
4. **Web-first & local-first, not native+account-required.** Step is app-store-only and needs
   sign-up. We start as a **responsive web app**, **local-first, no account** — dramatically lower
   friction to first value.
5. **No heavy recommender in v1.** Step leans on AWS Personalize. Personalized ML recs are an
   explicit **non-goal** for us; curation is human — lists the user edits and
   [posts](./posts.md) the user writes, closer to a geolocated blog than to Step's in-app
   curated city guides.

## Honest boundaries on import

Import is the lesson worth copying, but the input contract must remain explicit:

- **File import is the supported front door.** Google Takeout, KML/KMZ, GPX, and GeoJSON have
  inspectable formats and can be parsed locally. Every source row is accounted for, while OSM
  matching remains optional and ambiguity enters a persisted review queue.
- **Google/Apple shared-link scraping is not supported.** Redirects and page markup are unstable,
  incomplete, and governed by platform terms. Reconsider only if an official API provides a
  compliant import surface.
- **Instagram/TikTok import** relies on scraping/oEmbed and platform ToS that shift often; fragile
  and gray-area. Treat as experimental, not a v1 promise.
- **Screenshot import** needs OCR + geocoding + disambiguation — a real feature in its own right.

File import lands in Phase 3 immediately after the durable local core. It is not a Phase 1 search
feature; once available, it becomes the primary acquisition path for real user libraries.

## One-line summary

Step proved the *appetite* for a personal-map-of-places product and nailed frictionless **import**.
We differentiate with OSM-derived live data, portable file imports, personal-first local ownership,
and creator-controlled read-only links—without a social graph or proprietary places API calls.
