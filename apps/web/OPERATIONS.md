# Web app — operations

The test deployment is the Cloudflare Worker `placemarks-web`
(<https://placemarks-web.together-in-girona.workers.dev>): the built
single-page app served as static assets.

## Deploy

```sh
cd apps/web
pnpm run deploy
```

That builds the app and publishes it. It needs a Cloudflare login on the
machine (`pnpm exec wrangler login`, once). To build without publishing:
`pnpm run deploy --build-only`.

## Settings

| File | In git | Holds |
| --- | --- | --- |
| `deploy.env` | yes | The deployment's public settings: share service, tile service, OSM lookup. |
| `deploy.env.local` | no (`*.local` is ignored) | Keys and personal overrides. Wins over `deploy.env`. |

`deploy.env.local` on the deploying machine:

```sh
VITE_STADIA_KEY=<the Stadia Maps API key>
```

A plain `vite build` reads neither file, so tests and other builds are
unaffected.

## Stadia Maps key

Place search calls Stadia Maps from the browser, so the key is part of the
public bundle — anyone can read it. Two consequences:

- Changing the Stadia plan (free → Starter → Standard) keeps the same key:
  nothing to rebuild or redeploy.
- If the key is ever abused, rotate it in the Stadia dashboard, put the new
  one in `deploy.env.local`, and deploy again. Registering the site's domain
  in the dashboard (Manage Properties → Authentication Configuration) lets
  the site work with no key in the bundle at all.
