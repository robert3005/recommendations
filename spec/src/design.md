# Visual Design

The direction is **instrument-panel retrofuturism**: the clean-lined, optimistic mid-century idea
of the future — Eames-era cartography, the NASA punch-card era, Braun dials — not neon cyberpunk.
A deep-green console, precise hairlines, and a small set of bright signal colours doing real
work: dark chrome around a lit chart. The whole system serves one job: the eight list-marker
accents are the loudest, clearest thing in the app.

The system is expressed as Tailwind `@theme` tokens. This chapter names the tokens and gives rough
starting values; it fixes roles and relationships, not pixel specs.

## Paper and ink

The ground is the **deep-green console**: a mid-deep forest (`#223129`) — deliberately lifted
well clear of black, so the console sits beside the light map plate rather than clashing against
it — with warm off-white ink (`#E9EFE9`) and hairlines in a muted green (`#41544A`). The notebook, cards, sheets,
and the public viewer all sit on that same ground; structure comes from hairlines and whitespace,
not background changes. The one exception is `--color-panel` (`#2B3C33`), a single slightly-raised
surface reserved for popups and menus that must sit above the ground.

The basemap deliberately stays a light plate (see [Map styling](#map-styling)), so the console
frames a lit chart and the accent pins dominate it. Because the ground is dark, the deepened
accent variants are *lightened* to stay text-safe. There is one theme; a light theme is a listed
future.

## The eight accents

The accent palette **is** the list-marker palette, and these are the only hues in the app. Each
accent has a bright fill token and a text-safe variant at `--color-accent-<name>-deep` for small
text on paper, where the bright fill would fall short of readable contrast. The paper is dark, so
"deep" variants are in fact *lightened* toward the ink — the token name fixes the role (readable
small text on paper), not a direction on the lightness scale.

| Accent | Token | Fill start | Deep start |
|---|---|---|---|
| Signal orange | `--color-accent-orange` | `#F97316` | `#FBA45C` |
| Cobalt | `--color-accent-cobalt` | `#2457E6` | `#7FA0F5` |
| Kelly green | `--color-accent-green` | `#17A34A` | `#5CCB8A` |
| Magenta | `--color-accent-magenta` | `#D6219C` | `#EC72C4` |
| Cyan | `--color-accent-cyan` | `#08AECE` | `#5BCFE6` |
| Golden yellow | `--color-accent-gold` | `#F0B100` | `#F5CB4D` |
| Vermilion | `--color-accent-vermilion` | `#E43D1F` | `#F58063` |
| Violet | `--color-accent-violet` | `#7C3AED` | `#AD8BF7` |

Bright fills are for markers, toggles, and large type; deep variants are for small text on paper
and should hold roughly 4.5:1 contrast against it. Values are starting points, tuned during the
visual-system pass — the token names and the eight-accent count are the fixed part.

## Clean lines

Rules and borders are 1px hairlines, never heavier. Corners take a sharp 2px radius everywhere.
Whitespace is generous; density comes from good setting, not tight packing. No shadow is heavier
than a hairline — elevation is drawn with borders, not blur. The notebook should read like a
well-set field notebook: ruled, calm, and precise.

## Type

- **Display and UI** — a geometric sans (Space Grotesk-class) with tabular numerals, so counts
  and coordinates hold their columns like dial readouts.
- **Article bodies** — a readable text face; posts are for reading, not for chrome.
- **Instrument accents** — coordinates, place counts, and slugs render in a monospaced accent
  style: the small, deliberate instrument-panel nod, used sparingly.

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

The basemap is neutral and desaturated — a light, quiet plate restyled from the provider's
default (see [Map Data & Providers](./data-sources.md)) so that accent pins are the loudest thing
on the canvas. It deliberately stays light while the chrome is dark: the console frames a lit
chart, and the map reads as the bright instrument in the panel rather than dissolving into it.

Two consequences follow. Every control floating over the map — the list-toggle chips, the
reopen affordance, the unavailable banner, attribution — reads as a deep console chip: solid
paper, hairline border, ink text. And everything painted *into* the map scene (pin outlines,
cluster discs) contrasts against the light plate, not the dark chrome — those
are fixed plate values, not the chrome tokens. Attribution is always visible.

## Motion

Motion is small, fast, and purposeful: camera flights and sheet detents are the only animated
things. Under `prefers-reduced-motion` every one of them completes instantly.

## Token families

- **Paper** — `--color-paper` (`#223129`): the one background — deep forest, not black.
- **Ink** — `--color-ink` (`#E9EFE9`): text, icons, and controls at full strength — warm
  off-white.
- **Panel** — `--color-panel` (`#2B3C33`): the one raised surface, only for popups and menus
  that sit above the ground.
- **Accents** — `--color-accent-<name>` and `--color-accent-<name>-deep`, eight of each (table
  above). No other hues exist in the app.
- **Hairline** — `--color-hairline` (`#41544A`): every rule and border, at 1px.
- **Radius** — `--radius-crisp` (`2px`): the one corner radius.
- **Type** — `--font-display`, `--font-body`, `--font-mono`; the size scale keeps Tailwind's
  default `--text-*` steps.

Storybook is the design-QA harness for the marker and token system (see
[Tech Stack](./tech-stack.md)).
