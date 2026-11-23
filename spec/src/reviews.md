# Review Insights

Placemarks reads what other people wrote about a place and shows what was learned from it: a short
summary, aspect scores, the dishes people order, price, tags and warnings, plus the place's photos.
Reviews are **input only**. The app never displays review text; it displays classification results.

## Where it runs

Two routes lead to the same place card.

### Hosted on import (the default)

When places with a Google Maps link enter the library (a Takeout import, or a row placed from
the review queue), the app asks the share service for each one at `POST /i/places`, two at a
time, while the app is open. Settings → Review insights also offers to read every Google place
that has no insights yet, and a place card without insights has a "Read what reviewers say"
button.

For each place the service:

1. looks the listing up on SerpApi by its Google feature id and coordinates (or by name near
   the coordinates, accepting only the listing whose id matches);
2. pages through its newest reviews, 50 by default (`INSIGHTS_MAX_REVIEWS`);
3. classifies them with Claude Haiku 5.5 through the same pipeline as the local command
   (`packages/classify/src/pipeline.ts`), then writes the summary;
4. answers with the place facts, up to 24 photo links with their credits, the review counts and
   the profile, and caches that answer in D1 (`insights`) for 30 days.

Review text exists only in that request's memory: it is never stored by the service and never
sent to the app. Every lookup costs SerpApi credits (about four per place) and model tokens, so
the route takes the operator's access key (`INSIGHTS_ACCESS_KEY`, kept in each browser's local
storage, never in the library, sync or anything published) and stops at a daily budget of places
(`INSIGHTS_DAILY_PLACES`, 100 by default). A cached answer is free; `refresh` refetches one only
when it is older than a week. A wrong key, an exhausted budget or a service without keys stops
the queue at once instead of failing every place.

Consumer subscriptions cannot pay for this: Anthropic does not allow third-party apps to sign in
with a Claude plan, and "Sign in with ChatGPT" is open only to approved partners (checked
November 2026). The service uses API keys.

### Local

The harvester (see the harvest chapter) writes one folder per place under
`~/placemarks-data/places/<dir>/` with `place.json`, `reviews.jsonl` and `photos.jsonl`. The
local classify command reads those files and writes its results beside them:

| File | Written by | Read by the app |
|---|---|---|
| `place.json` | harvest | yes: name, rating, rating count, price level |
| `reviews.jsonl` | harvest | **never** |
| `photos.jsonl` + `photos/` | harvest | yes, with each photo's credit |
| `analyses.<classifier>.jsonl` | classify | no |
| `profile.json` | classify | yes |
| `profile.<classifier>.json` | classify | no (comparison runs) |

```sh
pnpm --filter @placemarks/classify classify run [--with haiku|jev|luna] [--place KEY]
pnpm --filter @placemarks/classify classify compare --with haiku,luna
```

Settings → Review insights loads that folder. This route stays for comparison runs, other
classifiers and places the service cannot reach.

### In the browser

Either way, insights land in the app's own IndexedDB database, `placemarks-reviews`, separate
from the library: the library archive, the repository invariants and publishing never touch it.
A library place joins its insights by the Google feature id parsed from its `googleUrl`, which is
the harvest's `sourcePlaceKey`. Published pages carry no review data or review photos.

## Classifiers

One `ReviewClassifier` interface, three implementations:

- **Claude Haiku 5.5** (`claude-haiku-5-5`), the default: about 20 reviews per request with a
  strict output schema. With `ANTHROPIC_API_KEY` set it calls the API (structured outputs, low
  effort, a cached system prompt); without one it runs the local Claude Code CLI (`claude -p`, no
  tools, no MCP servers, no saved session) on the owner's own login. `--with haiku-api` and
  `--with haiku-cli` force one or the other.
- **Jev** (TypeSafe, `jev-latest`): answers fixed questions with calibrated probabilities, one
  review per request. It fills the fixed vocabulary only: no dishes, no quotes, no summary.
  Credentials: `TYPESAFE_API_KEY`.
- **Luna** (`gpt-6-luna` by default; `--model` takes any Codex slug) through the Codex CLI (`codex exec` with a strict output schema) and the owner's own
  ChatGPT login. Slow per call; meant for comparison runs.

`compare` runs two classifiers on the same reviews and reports agreement per field (usefulness,
sentiment, aspects, price, tags, red flags, dishes) and the reviews they disagree on most.

## The scheme

Per review, a classifier extracts:

- overall **sentiment** on a five-step scale, −2 to +2, and whether the review is **useful**
  (spam, empty and off-topic reviews are kept out of every aggregate);
- **aspects** (food, service, value, ambience, wait, cleanliness), each with a sentiment and a
  verbatim evidence quote;
- **dishes** with a normalized name, sentiment and quote;
- a **price** signal (cheap, moderate, pricey, very expensive);
- fixed-vocabulary **occasions**, **dietary** (served well or poorly) and **vibes**;
- **practical** notes (booking advised, typical wait, cash only) and **red flags** (food safety,
  rude staff, overcharging, closed or moved).

Quotes that are not verbatim substrings of the review are dropped. Analyses are stamped with the
classifier, the prompt version and the review's content hash; a re-run only sends reviews whose
stamp is missing or stale.

Per place, code (not a model) builds the profile: recency-weighted mean sentiment per aspect (a
review's weight halves every year), dishes grouped by normalized name, the most common price
signal, tags reaching at least 3 mentions and 10% of useful reviews, and warnings with at least 2
mentions in the last 18 months. One last model call writes the two or three sentence summary from
those facts and their evidence, citing review ids.

## The place card

The card opens with a photo gallery (a 3:2 hero, four thumbnails, a full-screen lightbox, a credit
on every photo), then "What people say": the Google rating and price, the summary, any warnings,
aspect meters with mention counts, the top dishes, atmosphere, good-for and dietary tags, practical
notes, and a provenance line naming the classifier and how many reviews it read. Meters and tags are
drawn in ink and hairlines; the eight accents stay with lists. A place whose reviews are downloaded
but not yet classified says so and names the command to run; one the service read with no
written reviews says that.
