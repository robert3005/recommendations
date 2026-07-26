# The Notebook & the Map

Almost every screen in Placemarks is the same scene: content about places beside a map showing
them. So the map is not a page. The app is a **notebook** — the pane where every route renders —
beside a **single persistent map canvas**, which never navigates: it projects whatever the
notebook is showing. The lists are the home; the notebook opens on them.

## The grammar

```text
DESKTOP — every route renders notebook + canvas      MOBILE — sheet over canvas
┌───────────────────┬───────────────────────┐        ┌──────────────────┐
│  NOTEBOOK         │   MAP CANVAS          │        │ ░░░ MAP ░░░░░░░  │
│  home · list ·    │   always mounted;     │        │ ┌──────────────┐ │
│  post · editor ·  │   projects the        │        │ │ NOTEBOOK     │ │
│  review · ⚙      │   route's places      │        │ │ SHEET        │ │
│  [⟨] collapse     │   ◉ ◆ ▲              │        │ │ (same routes)│ │
└───────────────────┴───────────────────────┘        └─┴──────────────┴─┘
```

- **The top bar is for search.** The notebook header is a small home affordance — the wordmark,
  back to `/` — with the add-a-place field filling the remaining width, beside the pane step
  buttons. There is no persistent nav: **Settings** hides behind a small floating gear chip
  pinned bottom-left of the shell — a toggle that expands a collapsed notebook so the page is
  actually visible, and returns to the page it came from when pressed again — and **Review**
  is exposed only while an import batch is
  reviewing — a pill in the top bar carrying the review-queue count, gone when the queue
  closes; `/review` itself stays deep-linkable. Public pages keep the read-only chrome.
- **Two desktop widths.** The notebook is **split** (the default) or **collapsed** (full-bleed
  map); the map is one collapse away, never a tab switch.
- **Three mobile detents.** The notebook is a sheet over the canvas with **peek**, **half**, and
  **full** detents. While the sheet fully covers the canvas, projections apply lazily on reveal.
- **One map instance.** The canvas is a singleton in the app shell, outside the route outlet: it
  never remounts on navigation, and the viewport survives route changes. The last viewport
  persists in the `settings` store ([Local Storage](./storage.md)); the camera is not carried in
  the URL. A first launch centres on an approximate location derived locally from the device
  timezone — no permission prompt, no network request.
- **The canvas projects the route.**

  | Notebook (route) | Canvas projection |
  |---|---|
  | `/` home | every list's places, each pin wearing its list's marker; the toggle row filters |
  | `/list/:id` (read or edit mode) | that list's places; the rest of the library dimmed |
  | `/post/:id` (reading) | the post's places — its target's, per the projection rule |
  | `/post/:id/edit` | the same projection; tapping a pin inserts a mention — an in-body link to a place ([Posts](./posts.md)) |
  | Import review | the item under review; manual placement by clicking the map |
  | `/l/:slug` · `/p/:slug` public viewers | the published places, same grammar, read-only chrome |
  | Settings | viewport unchanged |

  Settings is a notebook route like any other: library-archive export and import
  ([Local Storage](./storage.md)) and provider and privacy information
  ([Map Data & Providers](./data-sources.md)) live there, and the canvas keeps its viewport.
- **Selection is bidirectional, and every selection centres.** Tap a pin → its place card opens —
  a column beside the notebook on desktop, a bottom sheet over the canvas on mobile; select in
  the notebook → the same. Either way the canvas centres the place with one camera move (instant
  under `prefers-reduced-motion`), and the requested zoom is a floor — centring never zooms the
  user out of a closer view. The selected pin is unmistakable beside its list-mates: enlarged,
  never dimmed, stacked above its neighbours, and wearing the ink selection ring. The notebook
  is the map's synchronised non-map equivalent for accessibility.

Pins are solid accent-coloured shapes wearing their list's marker; a place on several lists wears
a deterministic stacked/badged variant naming its lists on tap ([Visual Design](./design.md)).
Library pins cluster at low zoom so large lists stay responsive.

## Home (`/`)

```text
┌─────────────────────────────────────────────┐
│  Lists                                      │
│                                             │
│  ◉ Lisbon eats                    12 places │
│  ◆ Porto weekend                   7 places │
│  ▲ Hikes to try                    4 places │
│                                             │
│  + New list  ·  ⤓ Import                    │
└─────────────────────────────────────────────┘
```

The notebook opens on the lists: each row is the list's **marker**, name, and place count —
nothing else. The home body carries the actions that feed lists: **New list** and **Import**
([Import & Export](./interop.md)); the add-a-place field sits in the top bar above. The canvas
overlays every list's places, each pin wearing its list's marker; a **toggle row** over the
overlay turns individual lists on and off — all on by default, the state persisted in the
`settings` store.

## The list page (`/list/:id`)

The canvas shows the list's places with the rest of the library dimmed. The entries are the
visual centre of the notebook page: full-width rows with room to breathe, and the **whole row is
one selection target** — activating it (pointer or keyboard) selects the place, so the canvas
highlights and flies (selection is bidirectional). The secondary controls share one compact
header row beside the title: the **Edit mode** toggle and **Export** — a single menu button
opening an accessible menu of every artefact download plus the My Maps and uMap guided handoffs
([Import & Export](./interop.md)). **Edit mode** is where curation lives: reorder entries,
rename the list, remove entries, and change the marker (swapping within free shape + colour
pairs); its per-row controls are separate targets that never steal the row's selection. The
share/publish entry point ([Sharing & Publishing](./sharing.md)) keeps its own place on the
page. **Posts are the page's quiet alternate view**: a small, deliberately unaccented
Places/Posts toggle under the header — muted text tabs, no accent colour. **Places** (the
default) is the entries list; **Posts** shows this list's posts with **New post**, which
creates a list post and opens the editor; selecting a post still opens its split reading view.

## Reading a post (`/post/:id`)

A split view: the article in the notebook, the canvas projecting the post's places. Post
projection is one rule on all surfaces: a post projects its target's places — a list post its
list's members, a place post its one place. Selecting a mention flies the camera (instant under
`prefers-reduced-motion`); selecting a pin scrolls to its mention. Cross-post links navigate.

## The post editor (`/post/:id/edit`)

The Markdown editor in the notebook beside the canvas projecting the post's places — a list post
shows all the places on its list, a place post its one place. Tapping a pin inserts a mention at
the cursor. An **Insert post link** affordance opens a picker — for a list post it lists the
place posts of the list's members first, then other posts — inserting a `post:` link. A preview
toggle renders the sanitised article in place ([Posts](./posts.md)).

## The place card

On desktop the card is its own column beside the notebook; on mobile it is a bottom sheet. It
reads as a listing, not a record, and its contents are, top to bottom — each only when present:

- The **photo** (Wikimedia-hosted, from the OSM element's tags or its Wikipedia article —
  captured at paste-time lookup or by the enrichment pass below), with a small Wikimedia
  Commons credit link; a failed load hides the photo block.
- The **name**, then one muted line of **category · cuisine**.
- The **description** paragraph, set with relaxed line-height — the OSM `description` tag, or
  the linked Wikipedia article's summary. Wikipedia-sourced text carries a small **Wikipedia**
  credit link to the article, titled with its CC BY-SA licence.
- The **address**.
- Compact **fact rows**: website (a normalized https link, its hostname as the text), phone (a
  `tel:` link), opening hours (the raw `opening_hours` value, in the mono face), and wheelchair
  access ("Wheelchair accessible" / "Partly accessible" / "Not accessible").
- Deep links out: **Open in Google Maps** (the retained `googleUrl` when one exists, else a
  coordinate/name search URL), **Open in Apple Maps**, and **View on OpenStreetMap** when the
  place carries an `osmRef` — the OSM element page is also where fact corrections happen.
- **Add to list** — pick a list or create one inline. Membership is existence
  ([Data Model](./data-model.md)): joining a list is how a place enters the library.
- The place's posts, when any exist, plus **Write a post**, which creates a place post and opens
  the editor.

Coordinates do not appear anywhere on the card — they were chrome, not information; the pin on
the canvas is the coordinate display. Opening the card of a place with an `osmRef` fires one
fire-and-forget enrichment pass — capture rules and the fill-only-missing guarantee are in
[Data Model](./data-model.md) §Normative rules — so places added before their facts were
captured gain them the first time they are looked at.

## The add-a-place field

One field, two behaviours, both deliberately minimal: paste a Google Maps / Apple Maps / OSM URL
(parsed, never fetched; `maps.app.goo.gl` short links ask for the expanded URL), or type to
search: text in, geocoder results out, pick one, pick a list. Both end in "pick a list" because
membership is existence. That sentence is the whole search spec; there is no ranking or discovery
UX beyond it. Link parsing lives in [Import & Export](./interop.md), the geocoder in
[Map Data & Providers](./data-sources.md). The field owns the shell's top bar, so it is
reachable on every private route: a compact single-line input whose results, notices, and the
confirm card open as a panel below the header.

## Import review

Import review is a notebook route: the item under review projects onto the canvas, its geocoder
candidates appear as pins to pick from, and manual placement is a click on the map. The flow
itself — the coordinate ladder, review queue, and import report — is specified in
[Import & Export](./interop.md).

## The public viewer (`/l/:slug`, `/p/:slug`)

The same grammar with read-only chrome and no account: a published list or post renders in the
notebook beside the canvas projecting its places, exactly as published
([Sharing & Publishing](./sharing.md)).

## Accessibility and failure

All list, post, place, import, and publication workflows are keyboard operable; sheets use dialog
semantics with managed focus, labelled controls, and non-gesture dismissal; under
`prefers-reduced-motion` every camera flight becomes an instant recentre. A basemap style or tile
failure exposes an accessible **Map unavailable** banner — top-anchored, not a full-bleed overlay,
because the map may be otherwise drawn and usable — and it clears only on positive evidence of
recovery (successful data traffic), never on a failed request cycle merely going idle.
