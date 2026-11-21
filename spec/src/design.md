# Visual Design

The direction is **the quiet paper**: a warm off-white notebook beside a light map, set in clean
modern type, with hairlines doing the structural work. On top of that calm base sits a small
playful layer borrowed from retro desktop software — black pixel-face labels, bubblegum pink —
so the app feels friendly rather than corporate. The whole system still serves one job: the
eight list-marker accents are the loudest, clearest thing on screen.

The system is expressed as Tailwind `@theme` tokens in `apps/web/src/index.css`. This chapter
names the tokens and gives their starting values; it fixes roles and relationships, not pixel
specs.

## Themes

There are two themes, and only token values differ between them.

- **Paper** — the default. Warm off-white ground (`#FCFCF9`), warm near-black ink (`#171716`),
  hairlines in a light warm grey (`#DFDFDD`).
- **Night** — the dark theme, followed automatically from the device's
  `prefers-color-scheme: dark`. Neutral charcoal ground (`#171716`), off-white ink (`#F3F3EF`),
  hairlines at `#343431`.

There is no in-app theme switch. Components never branch on the theme; they use token
utilities and the tokens change underneath them.

## Paper and ink

The notebook, cards, sheets, and the public viewer all sit on the one **paper** ground;
structure comes from hairlines and whitespace, not background changes. Three quiet surfaces sit
beside it: `--color-panel` (white in Paper, `#222220` in Night) for popups and menus that float
above the ground; `--color-wash` for status chips; and the tag ground described under
[The playful layer](#the-playful-layer).

Secondary text is ink at reduced opacity, never below 60% for anything meant to be read.

## The eight accents

The accent palette **is** the list-marker palette. Each accent has a bright fill token and a
text-safe variant at `--color-accent-<name>-deep` for small text on paper, where the bright fill
would fall short of readable contrast. The token name fixes the role (readable small text on
paper), not a direction on the lightness scale: in Paper the deep variants are darkened, in
Night they are lightened.

| Accent | Token | Fill | Deep (Paper) | Deep (Night) |
|---|---|---|---|---|
| Signal orange | `--color-accent-orange` | `#F97316` | `#B4500C` | `#FBA45C` |
| Cobalt | `--color-accent-cobalt` | `#2457E6` | `#1D44C4` | `#7FA0F5` |
| Kelly green | `--color-accent-green` | `#17A34A` | `#0F7A36` | `#5CCB8A` |
| Magenta | `--color-accent-magenta` | `#D6219C` | `#AD1A7E` | `#EC72C4` |
| Cyan | `--color-accent-cyan` | `#08AECE` | `#067A91` | `#5BCFE6` |
| Golden yellow | `--color-accent-gold` | `#F0B100` | `#8A6500` | `#F5CB4D` |
| Vermilion | `--color-accent-vermilion` | `#E43D1F` | `#C2331A` | `#F58063` |
| Violet | `--color-accent-violet` | `#7C3AED` | `#6A2FD0` | `#AD8BF7` |

Bright fills are for markers, toggles, and large type; deep variants are for small text on paper
and should hold roughly 4.5:1 contrast against it. The token names and the eight-accent count
are the fixed part. The fills are the same in both themes, so a list's marker never changes
colour.

`--color-signal` is the focus colour — cobalt in Paper, its lightened form in Night.

## The playful layer

A deliberately small set of ornaments, used the same way everywhere:

- **Section labels** (`eyebrow`) — WHAT PEOPLE SAY, LISTS, POSTS — are black tags set in the
  pixel face with pink lettering, like highlighted terminal text. In Night the tag inverts: a
  pink tag with dark lettering.
- **Data tags** — the dishes people order — are the same tag ground in the mono face, the name
  in `--color-tag-text` and the count in `--color-tag-accent`.
- **Meters** are outlined pills with a pink (`--color-blush`) fill.
- **Hover** — the row or control under the pointer fills with `--color-hover`: pink in Paper, a
  deep magenta in Night so light text stays readable.

Pink is ornament and state, never information: nothing is communicated by pink alone, and it
never competes with a list accent for meaning. The pixel face is for labels only, never running
text.

## Clean lines

Rules and borders are 1px hairlines, never heavier. There are two radii, assigned by role:
**surfaces** — cards, images, menus, tags — take the crisp 2px radius; **anything pressed or
typed into** — buttons, fields, list chips, meters — is a full pill. Whitespace is generous;
density comes from good setting, not tight packing.

There is one shadow, `--shadow-lift`: a wide, soft lift reserved for things that float — controls
over the map, popups and menus, and the primary action. Everything else is flat; elevation is
otherwise drawn with hairlines.

## Type

All faces are open-licensed and self-hosted with the app (Latin and Latin Extended subsets), so
the offline shell and the content security policy never depend on a font host.

- **Display** — Schibsted Grotesk: headings and anything pressed. Page and place titles are
  large and tight (about 2–2.5rem, line-height 1, semibold).
- **Text** — Inter: UI copy, summaries, and article bodies. Tabular numerals, so counts hold
  their columns.
- **Mono** — Geist Mono: coordinates, place counts, slugs, opening hours, and data tags.
- **Pixel** — VT323: section labels only.

## Markers

A marker is a shape–colour pair: one of eight named shapes — circle, diamond, triangle, square,
hexagon, star, semicircle, chevron — in one of the eight accents, a pair space of 64. On the map
a pin is an **anchored drop**: an accent-coloured teardrop whose tail tip points at the exact
spot, with the list's shape stamped paper-on-accent inside the head — the drop says *here*, the
colour and stamped shape say *which list*. In the notebook (rows, chips, swatches) the marker
stays the flat solid shape.

Assignment follows the model rules (see [Data Model](./data-model.md) for the invariant):
auto-assign the first free pair on list creation; imports take the nearest colour to the source
style, then the first free pair; manual change in list edit mode picks SHAPE FIRST, THEN COLOUR —
a row of the eight shapes, then the chosen shape in each accent — swapping within free pairs.
Uniqueness is enforced across live lists up to 64; beyond that, pairs repeat with a small numeral
badge as the deterministic variant and the UI says so.

A place on multiple visible lists wears a deterministic stacked/badged variant of its markers;
tapping it names the lists it belongs to. The selected place is the loudest pin on the plate:
half again as large, never dimmed, above its neighbours — the size is the signal; no ring.

## Map styling

The basemap is neutral and desaturated — a quiet plate restyled from the provider's default (see
[Map Data & Providers](./data-sources.md)) so that accent pins are the loudest thing on the
canvas. The plate follows the chrome theme: in Paper it is warm light greys chosen to sit beside
the paper as one surface; in Night it is a dark plate at the Night ground, with roads at hairline
strength and labels toward the ink but held back. Both are one layer set with two palettes
(`src/map/basemapStyle.ts`), so a theme change repaints the plate in place — the canvas never
reloads its style. A hosted fallback style (`VITE_MAP_STYLE_URL`) has one look and stays light.

Two consequences follow. Every control floating over the map — the list-toggle chips, the
reopen affordance, the map's own zoom and locate buttons, the unavailable banner, attribution —
reads as a lifted paper pill: solid paper, hairline border, the lift shadow. And everything
painted *into* the map scene (pin outlines, cluster discs) contrasts against the plate, not the
chrome — those are plate values, not the chrome tokens, with a Paper and a Night pair (outline
paper-on-accent in Paper, night-ground in Night). Attribution is always visible.

## Motion

Motion is small, fast, and purposeful: camera flights and sheet detents are the only animated
things. Under `prefers-reduced-motion` every one of them completes instantly.

## Token families

Values are Paper / Night where they differ.

- **Paper** — `--color-paper` (`#FCFCF9` / `#171716`): the one background.
- **Ink** — `--color-ink` (`#171716` / `#F3F3EF`): text, icons, and controls at full strength.
- **Panel** — `--color-panel` (`#FFFFFF` / `#222220`): popups and menus above the ground.
- **Wash** — `--color-wash` (`#EBEBE8` / `#2B2B29`): status chips.
- **Hairline** — `--color-hairline` (`#DFDFDD` / `#343431`): every rule and border, at 1px.
- **Signal** — `--color-signal` (`#2457E6` / `#7FA0F5`): focus.
- **Accents** — `--color-accent-<name>` and `--color-accent-<name>-deep`, eight of each (table
  above).
- **Tag** — `--color-tag` (`#171716` / `#F386A1`), `--color-tag-text` (`#FCFCF9` / `#171716`),
  `--color-tag-accent` (`#F7A1B8` / `#171716`): section labels and data tags.
- **Blush and hover** — `--color-blush` (`#F386A1`): meter fills; `--color-hover`
  (`#F7A8BC` / `#8F2A6B`): the fill under the pointer.
- **Radius** — `--radius-crisp` (`2px`) for surfaces, `--radius-pill` for controls.
- **Shadow** — `--shadow-lift`: the one shadow, for floating things.
- **Type** — `--font-display`, `--font-body`, `--font-mono`, `--font-pixel`; the size scale keeps
  Tailwind's default `--text-*` steps.

Storybook is the design-QA harness for the marker and token system (see
[Tech Stack](./tech-stack.md)).
