# @placemarks/harvester

Downloads Google Maps place facts and reviews into the local harvest dataset, as private input
for review classification. See [spec/src/harvest.md](../../spec/src/harvest.md) for the design
and `packages/schemas/src/harvest.ts` for the dataset contract.

## Requirements

- Node 22+ and pnpm (`pnpm install` at the repo root)
- Docker, for the self-hosted scraper ([gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper),
  pinned to `v1.19.0`). The first run pulls the image and a browser into the
  `placemarks-gosom-cache` volume. Or pass `--gosom-bin` with a locally built binary.

## Usage

```sh
cd tools/harvester
pnpm harvest takeout ~/Downloads/takeout-2026.zip --dry-run   # see what would be fetched
pnpm harvest takeout ~/Downloads/takeout-2026.zip
pnpm harvest search "ramen" --geo 51.5246,-0.0786 --radius 1500
pnpm harvest urls places.txt
pnpm harvest refresh --max-age 30
pnpm harvest status
```

Data goes to `~/placemarks-data` (or `$PLACEMARKS_DATA`, or `--data-dir`).

## SerpApi (full review history)

```sh
mkdir -p ~/.config/placemarks && install -m 600 /dev/null ~/.config/placemarks/serpapi-key
$EDITOR ~/.config/placemarks/serpapi-key        # paste the key; or export SERPAPI_KEY
pnpm harvest takeout takeout.zip --provider serpapi --max-reviews 50
```

Each request costs one SerpApi credit: one to look the place up, then one per page of reviews
(the first page holds about 8, later pages 20). `--max-reviews 50` is about 4 credits per place.
The run log prints the credits each batch used. Check the free plan's monthly quota before a
large Takeout run, and use `--dry-run` to see how many places it would fetch.

## Pace

Defaults are slow on purpose: one browser page at a time, 5 inputs per batch, 60–120 s between
batches, at most 150 inputs per rolling 24 hours, and places fetched in the last 30 days are
skipped. Ctrl-C stops after the current batch; re-running picks up where it stopped. A failed
batch stops the run instead of retrying into a block.

`--no-extra-reviews` fetches only the reviews on the place page, which is much faster.

## Completeness

Google shows anonymous visitors a limited view: in the first real run that was about 5 reviews
per place, however many exist. Place facts, rating histograms and photos come through in full. Each
`place.json` records `reviewCollection`: `complete`, `limited` or `partial`, with collected and
expected counts.

## Terms of service

Scraping Google Maps breaches Google's terms. This tool is for a private, local dataset: review
text and Google photos must never be published.
