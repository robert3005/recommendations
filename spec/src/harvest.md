# Review Harvest

Placemarks classifies what people say about a place. The text comes from Google Maps reviews,
which no file export and no official API provides in full, so a **local harvester** downloads them
to the owner's own machine. The harvest is private input for analysis: review text is never shown
in the app and never published.

## Shape

```text
your machine                                       browser
┌──────────────────────────────┐                 ┌───────────────────────────────┐
│ tools/harvester (Node CLI)   │  harvest        │ separate "placemarks-reviews" │
│  inputs: takeout | search |  │  dataset  ───▶  │ DB: place facts, photos,      │
│          urls | refresh      │  on disk        │ classifier output (no review  │
│  provider: gosom (Docker)    │                 │ text)                         │
└──────────────┬───────────────┘                 └───────────────────────────────┘
               │ same files
               ▼
   review classifier (Node CLI) → analyses + place profile, beside the reviews
```

The harvester and the classifier are command-line tools that run on the owner's machine. The web
app gains no network call: it loads place facts, photos and classifier output from the dataset,
the same file-shaped way it imports Takeout. Review text stays on disk.

## Inputs

| Command | What it harvests |
|---|---|
| `takeout <file>` | Every Google place in a Takeout `.zip`, a Saved-list `.csv` or `Saved Places.json`. Rows without a Google listing (dropped pins) are skipped and reported. |
| `search "<query>"` | The places a Google Maps search returns, optionally around `--geo` within `--radius`, or a strict grid inside `--bbox`. |
| `urls <file>` | Google Maps place URLs, one per line. |
| `refresh` | Places already in the dataset whose snapshot is older than `--max-age`. |

A URL input names one place, so only the provider's top match is kept for it, even when a
search-style URL matches several branches. A search input keeps every result.

Harvesting does not add anything to the library. A place still enters the library only through a
list ([Data Model](./data-model.md) §Membership is existence); the dataset joins to it by the
Google feature id the library already keeps in `googleUrl`.

## Provider

The first provider is the self-hosted [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)
(MIT), run through Docker at a pinned image tag, or as a local binary. It browses Google Maps
anonymously and collects what Google shows an anonymous visitor. In practice (first real run,
November 2026) that is a **limited view of about five reviews per place**, whatever the total:
5 of 56,858 for one deli. Place facts, rating histograms and photos come through in full. Each snapshot records how complete
the download was (`reviewCollection`: complete, limited or partial, collected against expected).

A paid scraping API (Apify or SerpApi) is therefore the route to review volume, not only the
fallback for when Google blocks the home connection. Providers sit behind one batch-shaped interface, so adding one changes no dataset
shape.

The harvester is deliberately slow: one browser page at a time, small batches, a jittered pause
between batches (60 to 120 seconds by default), and a rolling daily cap (150 inputs by default)
counted across runs. Places fetched within `--max-age` days are skipped without contacting Google.

## The dataset

```text
~/placemarks-data/                 ($PLACEMARKS_DATA overrides)
  manifest.json                    schema version + every run and every input's outcome
  places/<dir>/place.json          PlaceSnapshot — the latest facts
  places/<dir>/reviews.jsonl       one review per line
  places/<dir>/photos.jsonl        one photo per line
```

`<dir>` is the place's `sourcePlaceKey` (Google's `0x…:0x…` feature id, or `cid:<digits>`) with
`:` replaced by `_`. Every file carries the real key; readers take it from the file contents. The
zod schemas in `packages/schemas/src/harvest.ts` are the contract for the harvester, the
classifier and the web loader alike.

Writes are additive. A refresh replaces the snapshot, adds new reviews, replaces a review whose
`contentHash` (rating, text, owner reply) changed, and keeps reviews that have since disappeared.
Review and photo ids are deterministic, so re-harvesting never duplicates. Files are written via a
temporary file and a rename, and the manifest is saved after every batch, so an interrupted run
loses at most one batch and a re-run picks up the rest.

Every run ends with a report in the manifest and on the terminal: each input fetched, skipped as
fresh, not found, or failed with its reason. Nothing is dropped silently.

## Licensing and risk

Scraping Google Maps breaches Google's terms of service. The project accepts that risk for a
private, local dataset used for analysis, and limits it:

- review text and Google photos never leave the owner's machine, and nothing Google-derived is
  published through the share service;
- Google-derived facts still never flow into anything sent to OSM ([Import & Export](./interop.md));
- the harvester runs at a human pace and stops on the first failed batch rather than retrying
  into a block.

The official Places API was rejected for this job: it returns only a few reviews per place, its
terms allow caching only place IDs long term, and they forbid showing Places content alongside a
non-Google map, which is what the canvas is.
