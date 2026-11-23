# Tile service operations

`placemarks-tiles` is a Cloudflare Worker over the R2 bucket `placemarks-tiles`
(see `wrangler.toml`). The bucket holds `europe.pmtiles` (~49 GB), `fonts/` and
`sprites/`. The Worker serves:

- `GET /<archive>/<z>/<x>/<y>.mvt`: one tile from `<archive>.pmtiles`, gzip as
  stored, `Cache-Control: public, max-age=604800, s-maxage=2592000`. A tile
  the archive lacks is `204`.
- `GET /fonts/…` and `GET /sprites/…`: passed through from the bucket with the
  same lifetimes.

CORS is open (`*`): it is public, read-only map data.

## Deploy

From `services/tiles`:

```sh
pnpm install
pnpm test
pnpm deploy        # wrangler deploy
```

Replacing the archive needs no redeploy: the Worker notices the new ETag and
re-reads the header. Cached tiles stay in browsers for up to a week and at the
edge for up to a month, so purge the edge cache (or upload under a new archive
name, such as `europe-2027-01.pmtiles`, and point `VITE_MAP_TILES_URL` at it) when
the map data must change at once.

## Checking it live

```sh
T=https://placemarks-tiles.together-in-girona.workers.dev
O='Origin: https://placemarks-web.together-in-girona.workers.dev'
for p in europe/0/0/0.mvt europe/14/8290/6097.mvt \
         'fonts/Noto%20Sans%20Regular/0-255.pbf' sprites/v4/light.json; do
  for i in 1 2; do
    curl -sI -H "$O" "$T/$p" | grep -iE '^(HTTP|cache-control|content-encoding|access-control-allow-origin|cf-cache-status)'
  done
done
curl -s --compressed "$T/europe/0/0/0.mvt" | wc -c   # non-zero
```

Expect `200`, the cache-control above, `content-encoding: gzip` on tiles and
`access-control-allow-origin: *`. The Worker stores responses with the Cache
API (`caches.default`). If the second request never reports
`cf-cache-status: HIT`, edge caching is not happening on this host. Turn on
Workers Cache by adding this to `wrangler.toml` and redeploying:

```toml
[cache]
enabled = true
```

Or serve the Worker from a custom domain on a Cloudflare zone.

## The web app

A production build of `apps/web` must name the tile service explicitly (the
build fails closed otherwise):

```sh
VITE_MAP_TILES_URL='https://placemarks-tiles.together-in-girona.workers.dev/europe/{z}/{x}/{y}.mvt'
VITE_MAP_GLYPHS_URL='https://placemarks-tiles.together-in-girona.workers.dev/fonts/{fontstack}/{range}.pbf'
VITE_MAP_SPRITE_URL='https://placemarks-tiles.together-in-girona.workers.dev/sprites/v4/light'
```

Drop any old `VITE_MAP_PMTILES_URL` from the deploy environment. If
`VITE_MAP_TILES_URL` is set it takes precedence anyway, but leaving the old
variable around is confusing.
