# The Map View

The map is the home screen, paired with a fully usable list view. It should feel
familiar: a full-bleed map, floating search and filters, and content in a bottom sheet or side
panel.

## Layout

```text
┌─────────────────────────────────────────────┐
│  Search places, addresses…              (☰) │
│  [Eat] [Drink] [Shop] [Stay] [Culture] […] │
│                                             │
│                    MAP                      │
│            library pins · live POIs         │
│                                             │
│                                      ( ◎ )  │
│  © OpenStreetMap contributors               │
├─────────────────────────────────────────────┤
│  bottom sheet: place / list detail          │
└─────────────────────────────────────────────┘
```

Primary navigation leads to Map, Lists, and Settings. Place cards expose tags and notes;
Settings owns backup/restore and provider/privacy information. Publication status joins Settings
when sharing lands. The category chips map the detailed OSM taxonomy into the small top-level
groups adopted from [prior art](./prior-art-step.md).

## Core interactions

- **Pan / zoom / rotate** — standard MapLibre gestures with reduced-motion support.
- **Locate me** — a user-triggered permission request; location is not persisted. Only the minimum
  location bias required by the configured provider is sent externally.
- **Search** — type-ahead through the configured production search adapter. A selectable result that
  can enter the library must resolve to a typed OSM node, way, or relation.
- **Tap a POI** — opens its detail sheet. Discovery may come from compatible vector tiles or a
  bounded resolver query; selected details are hydrated through `PoiResolver`.
- **Long press** — opens nearby OSM candidates. The user selects the correct existing POI, or —
  when the spot is absent — chooses between the two options below.
- **Missing place** — **Add it on OpenStreetMap** opens the OSM editor at that coordinate; after
  upstream and downstream indexes update, reopening search or the candidate picker can find it.
  **Add unlinked pin** instead creates a local `origin: "manual"` place from an owner-provided
  name — offline-capable, clearly labeled, and linkable to OSM later.
- **Library pins** — drawn above transient POIs and **coloured by their list's user-selected
  marker** (2026-07-18): one list → that list's colour; several lists → a deterministic neutral.
  Unlinked manual pins keep their distinct orange marker. A library mark appears as soon as the
  place gains its first list membership — never only after deselection.
- **Selection ring** — the selected place (in the library or not) is marked immediately with a
  ring, and fly-to offsets the target above the bottom sheet so it stays visible.

Every OSM-backed `Place` begins with a resolved OSM element, copied first-seen evidence, and its
own immutable `PlaceId`; manual pins begin `unlinked` with owner-provided facts (see
[Durable Place Identity](./place-identity.md#unlinked-manual-places)).

## Place detail sheet

The mobile sheet / desktop panel shows (decisions of 2026-07-18):

- Name, category, address, normalized website link, phone, and opening-hours state.
- **No state marker on healthy places.** The only badge is "Not linked to OSM" on unlinked manual
  pins; freshness/recovery badges are deferred with the freshness UI (below).
- Personal actions: **Add tag**, **Add note**, and **Add to list** — pick an existing list or
  create a new one inline right on the card. **There is no Save button** (2026-07-18: membership
  is existence): adding a place to a list is the only way it enters the library, and **Remove
  place** takes it out of every list—which removes it entirely. Creating a list picks its **marker
  colour** from a swatch row (default: the next unused palette colour). The place card is the write
  surface for list *membership*; the default list view stays read-only for reading and navigation.
  Reordering, removal, renaming, and
  recolouring return with the interop milestone as a **deliberate Edit mode on the list page**
  (2026-07-18 — imported lists are too large for place-card-only curation; see
  [Import & Export](./interop.md#list-curation-returns-edit-mode)); editorial text still waits
  for the guide milestone. Lists a place already belongs to leave the dropdown; full membership
  display / reverse navigation may come later.
- **Navigation handoff** (2026-07-18): **Open in Google Maps** — the imported external-ref URL
  when one exists (it reopens the exact Google listing), else a coordinate/name search link — and
  **Open in Apple Maps**. Navigation itself stays external; no routing in-app.
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
("showing stored OSM data from…"), and the stale/unavailable/missing/needs-review badges and review
panel — is removed from the UI for now. The durable-identity model and conservative resolution
rules ([Durable Place Identity](./place-identity.md)) remain the design of record for when this
surface returns; library places simply display their stored facts until then.

## Layers and rendering

- **Basemap:** provider style JSON with required attribution; light/dark theme where supported.
- **Library-place layer:** GeoJSON derived from local `Place.lastVerified` evidence, clustered at low
  zoom and available offline after the app shell/data have loaded.
- **Live-POI layer:** transient, zoom/area/result bounded, visually secondary, and explicitly
  marked incomplete when the provider truncates results.
- **Selection layer:** highlights the active resolved OSM element or last-known coordinate.

## Performance and provider etiquette

- Prefer POIs already encoded in compatible vector tiles and hydrate only selected/library places.
- Debounce and cancel viewport requests after map movement; align cache keys to reusable tiles.
- Skip discovery below a configured minimum zoom and show a “zoom in” hint.
- Cache with provider-approved TTLs; use stale-while-revalidate, negative caching, retry/backoff, and
  a circuit breaker for repeated upstream failures.
- Cluster library pins so large lists remain responsive.

Public/demo OSM endpoints are development-only. Production traffic goes through the selected
managed or self-hosted adapters described in [Open Data Sources](./data-sources.md).

## Offline and failure states

- Library pins, list/guide views, notes, tags, and last-verified POI evidence remain usable.
- Uncached tiles, live search, live POIs, OSM refresh, and OSM editing require a network.
- A basemap style/tile failure leaves navigation, search, and list access usable and exposes an
  accessible **Map unavailable** state; a blank or silently broken canvas is not a designed state.
- Search, exact-resolution, nearby-candidate, and viewport-discovery failures each expose a bounded
  retry/error state appropriate to their surface.
- A resolver failure retains stored evidence and becomes `unavailable` in the domain; it never
  starts identity repair. Timestamp/state UI returns with the deferred freshness surface.
- A confirmed deleted element shows its last-known card plus retry, candidate review, and OSM links.
- Geolocation denied/unavailable starts from the last viewport or a neutral default and leaves
  search fully usable.

## Accessibility and responsiveness

- All place, search, filter, list/guide, and publication workflows are keyboard operable.
- A synchronized non-map result/list view provides equivalent content for screen readers and people
  who cannot operate the canvas.
- Sheets use dialog semantics, managed focus, labelled controls, and non-gesture dismissal.
- Respect `prefers-color-scheme` and `prefers-reduced-motion`; fly-to becomes an immediate recenter.
- Baseline focus, contrast, screen-reader, and touch-target checks are acceptance criteria for each
  phase rather than a final polish task.
