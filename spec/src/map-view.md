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
  back to `/`, shrunk to its initial on a phone — with the search field filling the remaining
  width, beside the pane step buttons (a step that cannot be taken is not drawn) and the
  **Settings** gear. Search results open as a panel below the *whole* bar, so they are as wide
  as the notebook on any screen. There is no persistent nav. The gear is a toggle: it returns to
  the page it came from when pressed again; while the desktop notebook is collapsed it floats on
  the canvas and expands the notebook so the page is actually visible. **Review**
  is exposed only while an import batch is
  reviewing — a pill in the top bar carrying the review-queue count, gone when the queue
  closes; `/review` itself stays deep-linkable. Public pages keep the read-only chrome.
- **Three form factors.** A phone is for *finding*: search and the map come first, the notebook
  is a sheet, the place card a second sheet above it, and the legend starts collapsed. A tablet
  cannot hold notebook, card and map side by side, so the card takes the notebook's column while
  a place is open. A desktop is for *editing and importing*: notebook, card and map sit side by
  side.
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
  never dimmed, stacked above its neighbours. The notebook
  is the map's synchronised non-map equivalent for accessibility.

Pins are anchored drops in the list's accent, tail tip on the exact spot, the list's shape
stamped inside the head; a place on several lists wears a deterministic stacked/badged variant
naming its lists on tap ([Visual Design](./design.md)). Library pins cluster at low zoom so
large lists stay responsive.

## Home (`/`)

```text
┌─────────────────────────────────────────────┐
│  Places 128             + New list  ⤓ Import│
│  [Your tags] [From reviews] [Rating]        │
│  [Been / want] [Lists]                      │
│                                             │
│  LISTS & VIEWS                              │
│  ◉ Lisbon eats                    12 places │
│  ◆ Porto weekend                   7 places │
│  ⬢ Date night                    view · 9   │
│                                             │
│  ALL PLACES                                 │
│  Brat ★★★ been                         ◉ ◆ │
│  #date night  #wood fire                    │
│  “Order the turbot for the table.”          │
└─────────────────────────────────────────────┘
```

The notebook opens on **the library**: every saved place, found by filtering. Top to bottom:

- **The filter.** Facet chips — your tags, tags from reviews, rating, been / want to go, lists
  (including "on no list") — each opening its options in place. Rating is a minimum: 1+, 2+, 3+,
  3.5+, 4+, 4.5+ or 5. Free text comes from the search
  field in the top bar. With a filter active the page shows the match count, **Save as view**,
  and **Clear**.
- **Lists & views**, while no filter is active: each row is the group's marker, its name, and a
  count. A list row opens the list page; a view row applies its filter.
- **The places** the filter matches (all of them when there is none): name, the owner's rating
  and status, the markers of the lists it is on, category and address, the owner's own tags, and
  the note. Rows carry own tags only — review tags stay on the card and in the filter, so a list
  of places reads as the owner's.

The canvas shows exactly the same set: the filter narrows the map as it narrows the page, and
the camera frames the results. A session opens framing the whole library; after that the home
moves the camera only for a filter.

### Layers

Every list and every saved view is a **layer**: a named chip in the legend over the canvas,
with its marker and the number of places it would draw, toggled on and off independently — all
on by default, the state persisted in the `settings` store. Places in no list and no view sit
under **Other places**, in a neutral marker outside the eight accents. A place shows while any
of its layers is on, wearing the marker of the first visible one (lists before views), with the
next peeking behind. The legend collapses to one chip, and starts collapsed on a phone.

Above neighbourhood zoom the library never clusters and each pin carries its place's name, so
the map reads without tapping, and a selected place is never hidden inside a count.

## The list page (`/list/:id`)

The canvas shows the list's places with the rest of the library dimmed. The entries are the
visual centre of the notebook page: full-width rows with room to breathe, and the **whole row is
one selection target** — activating it (pointer or keyboard) selects the place, so the canvas
highlights and flies (selection is bidirectional). The secondary controls share one compact
header row beside the title: the **Edit mode** toggle and **Export** — a single menu button
opening an accessible menu of every artefact download plus the My Maps and uMap guided handoffs
([Import & Export](./interop.md)). **Edit mode** is where curation lives: reorder entries,
rename the list, write its **intro** (shown under the title and published with the list),
remove entries (off this list — the place stays in the library), change the marker (swapping
within free shape + colour pairs), and **Delete list**, which asks once and keeps the places; its per-row controls are separate targets that never steal the row's selection. The
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
- The **name**, then one muted line of **category · cuisine**, shown as readable labels
  ("Coffee shop · Australian", never the provider's `coffee_shop;australian`).
- **The personal layer** — before anything a provider or a review says: the owner's rating
  (five stars, in halves: the left half of a star is a half, the right half a whole; pressing
  the current rating clears it; a slider to the keyboard), **Been** / **Want to go**, their tags (free text; Enter or a comma adds
  one, suggestions come from tags already used), and a short note. Each saves as it changes.
  When reviews suggest tags the owner has not used, they are offered underneath, and pressing
  one adopts it as an own tag.
- **What people say** ([Review Insights](./reviews.md)), when the place has classified reviews —
  its tags drawn as derived tags, never as the owner's.
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
- **Lists** — the lists the place is on, each removable, and a picker to add it to another or
  create one inline. Lists are optional ([Data Model](./data-model.md) §The library).
- The place's posts, when any exist, plus **Write a post**, which creates a place post and opens
  the editor.

- **Delete place**, last and explicit, behind one confirmation.

Coordinates do not appear anywhere on the card — they were chrome, not information; the pin on
the canvas is the coordinate display. Opening the card of a place with an `osmRef` fires one
fire-and-forget enrichment pass — capture rules and the fill-only-missing guarantee are in
[Data Model](./data-model.md) §Normative rules — so places added before their facts were
captured gain them the first time they are looked at.

## The search field

One field for finding a saved place and for adding a new one. Typing searches **the library
first** — the free-text rule in [Data Model](./data-model.md) §Normative rules, so a tag, a word
from a note, or a dish reviewers mention all find a place — and shows up to five matches under
**Your places**, then **Show all N on the map**, which applies the text as the home filter
(Enter with nothing highlighted does the same). Below, under **Add a new place**, are the
geocoder's results, leaning toward what the canvas is showing, with places already saved and
exact repeats left out. Picking a saved place opens it; picking a new one opens the confirm
card: the name (editable), the address, and **Save place** — one press, no list — with a list
picker beside it for putting the place straight on a list.

Pasting a Google Maps / Apple Maps / OSM URL goes to the same confirm card (parsed, never
fetched; `maps.app.goo.gl` short links ask for the expanded URL). There is no ranking beyond
"yours first"; link parsing lives in [Import & Export](./interop.md), the geocoder in
[Map Data & Providers](./data-sources.md). The field owns the shell's top bar, so it is
reachable on every private route.

## Import review

Import review is a notebook route: the item under review projects onto the canvas, its geocoder
candidates appear as pins to pick from, and manual placement is a click on the map. The flow
itself — the coordinate ladder, review queue, and import report — is specified in
[Import & Export](./interop.md).

## The public viewer (`/l/:slug`, `/p/:slug`)

The same grammar with read-only chrome and no account: a published list or post renders in the
notebook beside the canvas projecting its places, exactly as published
([Sharing & Publishing](./sharing.md)). A shared list leads with the curator: their name, the
place count, the version and its date, then the intro. Each place shows the curator's rating,
note and tags before the provider's facts, and ends with links to open it in Google Maps, Apple
Maps and OpenStreetMap. An open page refetches on return to the tab and about once a minute, so
a reader sees the curator's next version without reloading.

## Accessibility and failure

All list, post, place, import, and publication workflows are keyboard operable; sheets use dialog
semantics with managed focus, labelled controls, and non-gesture dismissal; under
`prefers-reduced-motion` every camera flight becomes an instant recentre. A basemap style or tile
failure exposes an accessible **Map unavailable** banner — top-anchored, not a full-bleed overlay,
because the map may be otherwise drawn and usable — and it clears only on positive evidence of
recovery (successful data traffic), never on a failed request cycle merely going idle.
