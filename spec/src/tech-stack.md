# Tech Stack

The rule is boring by default, exotic only where the design demands it. Specific vendors are
replaceable behind the adapter contracts in [Architecture Overview](./architecture.md); the data
model and the publication semantics are not.

## Choices

| Layer | Choice | Deciding argument |
|---|---|---|
| Language & tooling | TypeScript `strict`, pnpm workspaces | One language end to end; the core domain is a plain TS package shared by app and service |
| Framework | React 19 + Vite | The hot path is WebGL; buy ecosystem and iteration speed, not framework rendering performance |
| Routing & data | TanStack Router + TanStack Query | Typed routes for lists, posts, and slugs; Query owns the async edges (geocoder, share service) |
| UI state | Zustand — ephemeral UI only | Sheet detents, toggles, edit mode; domain truth lives in the repository, never in a store |
| Map | MapLibre GL JS, used directly | One persistent singleton canvas in the app shell; routes re-project it and never remount it |
| Local data | Dexie (IndexedDB) | Real multi-store transactions enforce the repository invariants ([Local Storage](./storage.md)) |
| Markdown | unified: remark-parse + remark-gfm → rehype-sanitize | One allowlist pipeline everywhere — editor preview, reading view, public viewer ([Posts](./posts.md)) |
| Import parsing | PapaParse, @tmcw/togeojson, fflate | Files are the integration surface — Takeout CSV/ZIP, My Maps KML/KMZ; no Google SDKs, no scraping |
| Export writers | Hand-written KML/GeoJSON/GPX/text writers | Small fixed templates; golden-snapshot tests pin every artefact byte for byte |
| Styling | Tailwind v4 | Carries the [Visual Design](./design.md) `@theme` tokens; one styling system, no bespoke CSS layer |
| Share service | Hono on Cloudflare Workers + D1 | The only backend — two tables (`documents`, `rate`); scale-to-zero suits an idle-most-of-the-time service |
| Offline shell | Service worker, app-shell precache only | The app itself always loads; nothing more is promised |
| Testing | Vitest + Playwright + MSW | Domain invariants in node; publish loop, IndexedDB, and the canvas end to end; one shared mock layer |
| Design QA | Storybook | The design-QA harness for the marker and token system |

Two of these rows are deliberately narrow, and the narrowness is the specification. The service
worker precaches the app shell and nothing else: the app loads offline, but there is no install
UX and no offline tiles — geocoding, tiles, and publishing need the network and say so
([Local Storage](./storage.md)). Storybook exists for one job: pinning the marker system — the
eight shapes across the eight accents — and the notebook components against the design tokens,
so the visual system is reviewed as a system rather than page by page.

## Explicitly rejected

- **Next.js** — SSR buys nothing behind a map canvas; the public viewer is a route in the same SPA.
- **Redux** — domain truth lives in Dexie; the only client state left standing is ephemeral UI.
- **GraphQL** — the whole backend is three REST verbs over two document kinds.
- **Sync engines and CRDTs** (Replicache, PowerSync, Electric) — sync here is last-writer-wins
  rows plus one small set merge for tags, over four routes on the existing Worker
  ([Sync Between Devices](./sync.md)); an engine would be most of the app's weight for a
  problem this size.
- **Supabase / Firebase** — their account-centred model fights per-publication bearer tokens.
- **A media service** — posts are text plus places; images in posts are a listed future.
- **Accounts and auth of any kind** — the editor token is the entire authorisation model
  ([Sharing & Publishing](./sharing.md)).

## Independence

Every vendor has a cheap exit: tiles are already a self-hosted Protomaps PMTiles archive, and self-hosted Photon or
Nominatim replaces the geocoder ([Map Data & Providers](./data-sources.md)). The share service is
plain Hono and runs unchanged on Node + Postgres behind the same contract.
