# The Map View

The map is the home screen, paired with a fully usable saved-place/list view. It should feel
familiar: a full-bleed map, floating search and filters, and content in a bottom sheet or side
panel.

## Layout

```text
┌─────────────────────────────────────────────┐
│  Search places, addresses…              (☰) │
│  [Eat] [Drink] [Shop] [Stay] [Culture] […] │
│                                             │
│                    MAP                      │
│             saved pins · live POIs          │
│                                             │
│                                      ( ◎ )  │
│  © OpenStreetMap contributors               │
├─────────────────────────────────────────────┤
│  bottom sheet: place / saved / guide detail │
└─────────────────────────────────────────────┘
```

The menu leads to All Saved, Tags, Lists, publication status, backup/restore, provider/privacy
information, and settings. The category chips map the detailed OSM taxonomy into the small
top-level groups adopted from [prior art](./prior-art-step.md).

## Core interactions

- **Pan / zoom / rotate** — standard MapLibre gestures with reduced-motion support.
- **Locate me** — a user-triggered permission request; location is not persisted. Only the minimum
  location bias required by the configured provider is sent externally.
- **Search** — type-ahead through the configured production search adapter. A saveable result must
  resolve to a typed OSM node, way, or relation.
- **Tap a POI** — opens its detail sheet. Discovery may come from compatible vector tiles or a
  bounded resolver query; selected details are hydrated through `PoiResolver`.
- **Long press** — opens nearby OSM candidates. The user selects the correct existing POI, or —
  when the spot is absent — chooses between the two options below.
- **Missing place** — **Add it on OpenStreetMap** opens the OSM editor at that coordinate (on
  return, **Check for OSM updates** retries discovery and creates the durable link when the POI
  appears), or **Save as unlinked pin** creates a local `origin: "manual"` place from an
  owner-provided name — offline-capable, clearly labeled, linkable to OSM later.
- **Saved pins** — distinct from transient POIs and colorable by the currently selected guide or
  tag filter. A deterministic neutral style is used when several colors apply. Unlinked manual
  pins carry a distinct marker/badge.

Every OSM-backed `Place` begins with a resolved OSM element, copied first-seen evidence, and its
own immutable `PlaceId`; manual pins begin `unlinked` with owner-provided facts (see
[Durable Place Identity](./place-identity.md#unlinked-manual-places)).

## Place detail sheet

The mobile sheet / desktop panel shows (decisions of 2026-07-18):

- Name, category, address, normalized website link, phone, and opening-hours state.
- **No state marker on healthy places.** The only badge is "Not linked to OSM" on unlinked manual
  pins; freshness/recovery badges are deferred with the freshness UI (below).
- Personal actions: **Save**, **Add tag**, and **Add note**. There is deliberately **no
  add-to-guide action here**: guides link to places from the guide editor, never the reverse.
  A place → guides reverse lookup may come later.
- The **single OSM affordance is a small "View on OpenStreetMap" portal link.** In-app
  Edit/Report/Directions/Check-for-updates actions are removed — the portal itself offers editing
  and issue reporting. An unlinked manual pin shows its owner-provided facts and a
  **Link to OpenStreetMap** action instead.
- **Notes open a full-screen editing experience**: a Markdown writing surface with a live
  sanitized preview. The persisted format is the Markdown source (book/src/notes.md).

The public OSM website/phone/hours are never silently overridden inside Placemarks; wrong facts
are corrected on the OSM portal.

### Deferred for now: OSM data freshness (2026-07-18)

The freshness surface — TTL-driven refresh, **Check for OSM updates**, evidence timestamps
("showing saved data from…"), and the stale/unavailable/missing/needs-review badges and review
panel — is removed from the UI for now. The durable-identity model and conservative resolution
rules ([Durable Place Identity](./place-identity.md)) remain the design of record for when this
surface returns; saved places simply display their stored facts until then.

## Layers and rendering

- **Basemap:** provider style JSON with required attribution; light/dark theme where supported.
- **Saved-place layer:** GeoJSON derived from local `Place.lastVerified` evidence, clustered at low
  zoom and available offline after the app shell/data have loaded.
- **Live-POI layer:** transient, zoom/area/result bounded, visually secondary, and explicitly
  marked incomplete when the provider truncates results.
- **Selection layer:** highlights the active resolved OSM element or last-known coordinate.

## Performance and provider etiquette

- Prefer POIs already encoded in compatible vector tiles and hydrate only selected/saved places.
- Debounce and cancel viewport requests after map movement; align cache keys to reusable tiles.
- Skip discovery below a configured minimum zoom and show a “zoom in” hint.
- Cache with provider-approved TTLs; use stale-while-revalidate, negative caching, retry/backoff, and
  a circuit breaker for repeated upstream failures.
- Cluster saved pins so large guides remain responsive.

Public/demo OSM endpoints are development-only. Production traffic goes through the selected
managed or self-hosted adapters described in [Open Data Sources](./data-sources.md).

## Offline and failure states

- Saved pins, guide/list views, notes, tags, and last-verified POI evidence remain usable.
- Uncached tiles, live search, live POIs, OSM refresh, and OSM editing require a network.
- A provider failure shows timestamped evidence and `unavailable`; it never starts identity repair.
- A confirmed deleted element shows its last-known card plus retry, candidate review, and OSM links.
- Geolocation denied/unavailable starts from the last viewport or a neutral default and leaves
  search fully usable.

## Accessibility and responsiveness

- All saved-place, search, filter, guide, and publication workflows are keyboard operable.
- A synchronized non-map result/list view provides equivalent content for screen readers and people
  who cannot operate the canvas.
- Sheets use dialog semantics, managed focus, labelled controls, and non-gesture dismissal.
- Respect `prefers-color-scheme` and `prefers-reduced-motion`; fly-to becomes an immediate recenter.
- Baseline focus, contrast, screen-reader, and touch-target checks are acceptance criteria for each
  phase rather than a final polish task.
