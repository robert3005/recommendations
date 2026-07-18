# Prior Art — Step: Your World

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
| **Import from links / screenshots** | Their standout feature — it directly solves the "places trapped in screenshots & DMs" problem we named in [Vision](./vision.md). Worth adopting, starting with the tractable case (**Google/Apple Maps share links** → extract name+coords → resolve an OSM candidate → create a durable `PlaceId`), with IG/TikTok/screenshot import as a stretch. See caveats below. |
| **Category taxonomy (eat/drink/shop/stay/culture/health)** | Clean and legible; maps well onto OSM tags. We adopt a similar top-level filter set (see [Map View](./map-view.md)). |
| **Photos + comments per place** | We have notes; adding optional **photos** (local blobs first) is a cheap, high-value memory feature. |
| **PostGIS for geo queries** | Validates our optional-backend choice — already our documented path in [Tech Stack](./tech-stack.md). |

## Where we deliberately diverge (our thesis)

These are the design bets that differentiate us — mostly by being *lighter and more open*:

1. **Open data, not proprietary.** Step's places data is closed/undisclosed. We are **OSM-only**
   and surface the **website** from OSM tags. Trade-off: OSM POI coverage and website data are
   thinner in some places — we accept that in exchange for openness and portable, attributable
   source data. Corrections go upstream to OSM rather than into an app-specific global overlay.
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
   explicit **non-goal** for us; curation is human and list-based.

## Honest caveats on the "import" feature

It's the most attractive thing to copy, and also the trickiest — worth being clear-eyed:

- **Maps-link import** (Google/Apple Maps share URLs) is the realistic starting point: parse the
  URL for a name/coords, then resolve an OSM feature. Ambiguous candidates still require user
  confirmation before creating a durable place identity.
- **Instagram/TikTok import** relies on scraping/oEmbed and platform ToS that shift often; fragile
  and gray-area. Treat as experimental, not a v1 promise.
- **Screenshot import** needs OCR + geocoding + disambiguation — a real feature in its own right.

We therefore slot import as a **post-core, opt-in** capability on the [Roadmap](./roadmap.md), not
a Phase 1 commitment.

## One-line summary

Step proved the *appetite* for a personal-map-of-places product and nailed frictionless **import**.
We differentiate by being **open (OSM), personal-first, link-shareable, and web/local-first** —
trading Step's social network and proprietary data for lower friction, creator-controlled read-only
links, and OSM-backed place identities that can be repaired when map elements change.
