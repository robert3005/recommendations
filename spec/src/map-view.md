# Views — the Content Pane & the Map Canvas

Almost every screen is the same scene: content about places beside a map showing them. So the map
is not a page. The app is a **content pane** (where routes render) beside a **single persistent map
canvas** (which never navigates — it re-projects whatever the pane shows). Lists are the home: the
pane opens on them.

## The grammar

```text
DESKTOP — every route renders pane + canvas          MOBILE — sheet over canvas
┌───────────────────┬───────────────────────┐        ┌──────────────────┐
│  CONTENT PANE     │   MAP CANVAS          │        │ ░░░ MAP ░░░░░░░ │
│  home · list ·    │   always mounted;     │        │ ┌──────────────┐ │
│  post · editor ·  │   projects the pane's │        │ │ CONTENT SHEET│ │
│  review · ⚙      │   places; toggles     │        │ │ (same routes)│ │
│  [⟨] collapse     │   ◉ ◆ ▲              │        │ │              │ │
└───────────────────┴───────────────────────┘        └─┴──────────────┴─┘
```

- **Three pane states, both form factors.** Desktop: **collapsed** (full-bleed map — the old
  "Map view" is this state), **split** (default), **expanded** (focused reading/writing).
  Mobile: the same three as sheet detents — **peek**, **half**, **full**. Launch opens the pane
  **expanded/full on the Lists home**; the map is one collapse or drag away, never a tab switch.
- **The canvas projects the route.**

  | Pane (route) | Canvas projection |
  |---|---|
  | `/` Lists home | every list's points, each wearing its list marker; list toggles |
  | `/list/:id` (read or Edit mode) | that list's points; the rest of the library dimmed |
  | `/post/:id` (reading) | the post's embeds; the camera follows the article as it scrolls |
  | `/post/:id/edit` (block editor) | embeds solid; the rest of the post's list dimmed as candidates |
  | Import review queue | the item under review plus its labelled candidates |
  | `/l/:slug` · `/n/:slug` public viewers | the shared places, same grammar, read-only chrome |
  | Settings | viewport unchanged |

- **Selection is bidirectional.** Tap a pin → its card rises in the pane/sheet; select in the
  pane → the canvas highlights and flies (respecting `prefers-reduced-motion`). The pane is
  also the map's synchronized non-map equivalent for accessibility.
- **One map instance.** The canvas is a singleton in the app shell, outside the route outlet: no
  re-mount on navigation, and the viewport survives route changes. The camera is *not* carried in
  the URL — that duplicated the persisted last viewport and forced a hand-ranked arbitration against
  fly-to and fit-to.
- **The canvas idles when fully hidden.** At pane **expanded** / sheet **full**, every projection
  effect returns early, so nothing is applied and no request is issued; on reveal each one runs
  against current values, producing one camera move. There is no buffer to coalesce: if nothing
  applies while hidden, only the last projection can ever apply. The provider style is not activated
  until first reveal, so a launch on the Lists home fetches no tiles at all.

- Settings (backup/restore, sync, import, provider/privacy information, publication status) is
  a pane route like any other.

## The Lists home (pane route `/`)

```text
┌─────────────────────────────────────────────┐
│  Lists                            [⟨] (☰)  │
│                                             │
│  ◉ Lisbon eats          12 places  ▸ post  │
│    Cervejaria Ramiro · Prado · Taberna …    │
│  ◆ Porto weekend         7 places          │
│    Casa Guedes · Venham Mais Cinco · Ca…    │
│  ▲ Hikes to try          4 places          │
│    Arrábida loop · Sintra coast · Peni…     │
│  + New list · ⤓ Import                     │
└─────────────────────────────────────────────┘
```

Each row shows the list's **marker (icon + colour)**, name, place count, a link to its
[posts](./posts.md) when any exist, and an **inline preview truncated to a fixed length** — the
first place names in list order, cut at one line. Tapping a row navigates the pane to the list
page (read view, Edit mode, export, share, posts) and the canvas to its points. The home also
carries the entry points that feed lists: **New list** and **Import** ([Interop](./interop.md)).

## The canvas

Floating on the canvas: search, the **list toggles** row — the primary filter; each list's marker
toggles its points on/off, all shown by default — the locate control, and **Show nearby places**.

Nearby places is an explicit, off-by-default request: one bounded fetch, cleared on pan, disabled
below the discovery zoom with the reason stated. Ambient discovery on every pan, and the category
taxonomy that filtered it, were removed on 2026-07-26 — that was the pre-pivot front door this book
rejects, and it was the only thing giving the canvas a standing network appetite. Tapping a
discovered POI to add it to a list is unchanged.

## Core interactions

- **Pan / zoom / rotate** — standard MapLibre gestures with reduced-motion support.
- **Starting camera** (2026-07-18) — the first launch centres on an **approximate location
  derived locally from the device timezone** (a city/region centroid): no permission prompt, no
  network request, nothing leaves the device. Every later launch restores the **last viewport**.
  Precise location stays behind the user-triggered Locate button.
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
- **Library pins** — drawn above transient POIs and wearing **their list's unique marker
  (icon + colour)** (2026-07-19; supersedes the colour-only ruling of 2026-07-18 — on the
  all-lists map, points must be attributable to their list at a glance, and colour alone runs out
  of legible distinctions). One list → that list's marker; several lists → a deterministic
  stacked/badged variant naming its lists on tap. An unlinked manual pin wears its list's marker
  with a small "not linked" dot (supersedes the distinct orange marker — list identity now owns
  the pin's look). A library mark appears as soon as the place gains its first list membership —
  never only after deselection.
- **Add to a list from the map** — the core curation gesture: tap a pin or POI → **Add to
  list** on its card; long-press → candidate picker → add. In a list's Edit mode the map stays
  interactive, so growing a list is browse-tap-add without leaving the map; the same gesture
  offers **Embed in post** when a post editor is open ([Posts](./posts.md#authoring)).
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
  place** takes it out of every list—which removes it entirely, and is therefore **refused while
  the place still carries your notes or a post embeds it** (bottom-up teardown, 2026-07-19 late:
  the dialog names the blockers; delete those first). Creating a list picks its
  **marker** from a swatch row of icon + colour combinations (default: the next unused
  combination — 2026-07-19, upgraded from colour-only); lists are also created **directly on the
  Lists home** (2026-07-18, late — a list may exist before any place joins it).
  The place card is the write surface for list *membership*; the default list view stays
  read-only for reading and navigation.
  Reordering, removal, renaming, and
  remarking live in a **deliberate Edit mode on the list page**
  (2026-07-18 — imported lists are too large for place-card-only curation; see
  [Import & Export](./interop.md#list-curation-returns-edit-mode)); editorial text belongs to
  [posts](./posts.md), never to the list. Lists a place already belongs to leave the dropdown;
  full membership display / reverse navigation may come later.
- **Navigation handoff** (2026-07-18): **Open in Google Maps** — the imported external-ref URL
  when one exists (it reopens the exact Google listing), else a coordinate/name search link — and
  **Open in Apple Maps**. Navigation itself stays external; no routing in-app.
- The **single OSM affordance is a small "View on OpenStreetMap" portal link.** In-app
  Edit/Report/Directions/Check-for-updates actions are removed — the portal itself offers editing
  and issue reporting. An unlinked manual pin shows its owner-provided facts and a
  **Link to OpenStreetMap** action instead.
- **Notes open a full-screen editing experience**: a Markdown writing surface with a live
  sanitized preview. The persisted format is the Markdown source (spec/src/notes.md).

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
- The idled canvas ([grammar](#the-grammar)) issues no requests at all; a deferred projection
  fetches once, on reveal.
- Debounce and cancel viewport requests after map movement; align cache keys to reusable tiles.
- Skip discovery below a configured minimum zoom and show a “zoom in” hint.
- Cache with provider-approved TTLs; use stale-while-revalidate, negative caching, retry/backoff, and
  a circuit breaker for repeated upstream failures.
- Cluster library pins so large lists remain responsive.

Public/demo OSM endpoints are development-only. Production traffic goes through the selected
managed or self-hosted adapters described in [Open Data Sources](./data-sources.md).

## Offline and failure states

- Library pins, list and post views, notes, tags, and last-verified POI evidence remain usable.
- Uncached tiles, live search, live POIs, OSM refresh, and OSM editing require a network.
- A basemap style/tile failure leaves navigation, search, and list access usable and exposes an
  accessible **Map unavailable** banner — top-anchored, not a full-bleed overlay, because a failed
  tile or glyph can happen over a map that is otherwise drawn and usable; a blank or silently broken canvas is not a designed state.
  This covers failures after the style loaded too: a tile-provider outage surfaces the same state,
  and a subsequent successful render clears it — the overlay recovers with the connection
  (2026-07-19).
  Clearing requires positive evidence of recovery (successful data traffic) — a failed request
  cycle merely going idle never clears it.
- `prefers-reduced-motion` recenters instantly instead of animating the camera (2026-07-19).
- Search, exact-resolution, nearby-candidate, and viewport-discovery failures each expose a bounded
  retry/error state appropriate to their surface.
- A resolver failure retains stored evidence and becomes `unavailable` in the domain; it never
  starts identity repair. Timestamp/state UI returns with the deferred freshness surface.
- A confirmed deleted element shows its last-known card plus retry, candidate review, and OSM links.
- Geolocation denied/unavailable starts from the last viewport or the timezone approximation and leaves
  search fully usable.

## Accessibility and responsiveness

- All place, search, filter, list, post, and publication workflows are keyboard operable.
- A synchronized non-map result/list view provides equivalent content for screen readers and people
  who cannot operate the canvas.
- Sheets use dialog semantics, managed focus, labelled controls, and non-gesture dismissal.
- Respect `prefers-color-scheme` and `prefers-reduced-motion`; fly-to becomes an immediate recenter.
- Baseline focus, contrast, screen-reader, and touch-target checks are acceptance criteria for each
  phase rather than a final polish task.
