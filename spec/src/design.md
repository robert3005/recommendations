# Visual Design

The direction is **instrument-panel retrofuturism**: the clean-lined, optimistic mid-century idea
of the future — Eames-era cartography, the NASA punch-card era, Braun dials — not neon cyberpunk.
Warm paper, precise hairlines, and a small set of bright signal colours doing real work. The whole
system serves one job: the eight list-marker accents are the loudest, clearest thing in the app.

The system is expressed as Tailwind `@theme` tokens. This chapter names the tokens and gives rough
starting values; it fixes roles and relationships, not pixel specs.

## Paper and ink

Every surface is warm near-white paper with near-black ink — the notebook, cards, sheets, and the
public viewer all sit on the same ground. There are no tinted panels; structure comes from
hairlines and whitespace, not background changes. V1 is light-only; dark mode is a listed future.

## The eight accents

The accent palette **is** the list-marker palette, and these are the only hues in the app. Each
accent has a bright fill token and a deepened text variant at `--color-accent-<name>-deep` for
small text on paper, where the bright fill would fall short of readable contrast.

| Accent | Token | Fill start | Deep start |
|---|---|---|---|
| Signal orange | `--color-accent-orange` | `#F97316` | `#B04A08` |
| Cobalt | `--color-accent-cobalt` | `#2457E6` | `#1B3EA9` |
| Kelly green | `--color-accent-green` | `#17A34A` | `#0E6B33` |
| Magenta | `--color-accent-magenta` | `#D6219C` | `#96156C` |
| Cyan | `--color-accent-cyan` | `#08AECE` | `#0E7490` |
| Golden yellow | `--color-accent-gold` | `#F0B100` | `#8A6400` |
| Vermilion | `--color-accent-vermilion` | `#E43D1F` | `#AC2410` |
| Violet | `--color-accent-violet` | `#7C3AED` | `#5B21B6` |

Bright fills are for markers, toggles, and large type; deepened variants are for small text on
paper and should hold roughly 4.5:1 contrast against it. Values are starting points, tuned during
the visual-system pass — the token names and the eight-accent count are the fixed part.

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
hexagon, star, semicircle, chevron — in one of the eight accents, a pair space of 64. Pins are
solid accent-coloured shapes (no glyph cutouts), so they stay legible at map sizes.

Assignment follows the model rules (see [Data Model](./data-model.md) for the invariant):
auto-assign the first free pair on list creation; imports take the nearest colour to the source
style, then the first free pair; manual change in list edit mode swaps within free pairs.
Uniqueness is enforced across live lists up to 64; beyond that, pairs repeat with a small numeral
badge as the deterministic variant and the UI says so.

A place on multiple visible lists wears a deterministic stacked/badged variant of its markers;
tapping it names the lists it belongs to.

## Map styling

The basemap is neutral and desaturated — a light, quiet ground restyled from the provider's
default (see [Map Data & Providers](./data-sources.md)) so that accent pins are the loudest thing
on the canvas. Attribution is always visible.

## Motion

Motion is small, fast, and purposeful: camera flights and sheet detents are the only animated
things. Under `prefers-reduced-motion` every one of them completes instantly.

## Token families

- **Paper** — `--color-paper` (`#FAF7F2`): the one background.
- **Ink** — `--color-ink` (`#221D16`): text, icons, and controls at full strength.
- **Accents** — `--color-accent-<name>` and `--color-accent-<name>-deep`, eight of each (table
  above). No other hues exist in the app.
- **Hairline** — `--color-hairline` (`#E6DFD2`): every rule and border, at 1px.
- **Radius** — `--radius-crisp` (`2px`): the one corner radius.
- **Type** — `--font-display`, `--font-body`, `--font-mono`; the size scale keeps Tailwind's
  default `--text-*` steps.

Storybook is the design-QA harness for the marker and token system (see
[Tech Stack](./tech-stack.md)).
