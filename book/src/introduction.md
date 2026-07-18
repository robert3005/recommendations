# Introduction

**Placemarks** (working title) is a personal location-recommendation app built around open maps and
portable user data. Think of it as *your own map* — import or add places, group them into lists,
tag them, write about them, and publish selected editorial content as read-only guides.

It is deliberately **not** a full-featured places platform. We don't scrape reviews, we don't
run a social feed, and we don't try to replicate Google Places. Instead we do three things well:

1. Show a fast, clean **map** in the spirit of Google/Apple Maps.
2. Let you **tag and group** places into lists and narrative guides.
3. Surface just enough **place info from OSM** — importantly, a **website link** when one exists.

## Principles

- **Open live data.** Map tiles, live geocoding, and live place metadata come from OpenStreetMap
  and OSM-derived services. User-exported files may contribute private imported facts, kept
  technically separate from OSM observations. Wrong or missing public facts are corrected
  upstream in OSM; Placemarks does not maintain a competing global POI layer.
- **Durable identity.** Personal content joins through an app-owned place id. The linked OSM
  element may be conservatively re-resolved from copied source evidence if OSM changes shape.
- **Local-first.** Your owned data lives on your device and edits commit locally. No account is
  required; live search, OSM refresh, publishing, and uncached maps still need connectivity.
- **Read-only sharing.** A public guide URL is read-only. Its creator can update or revoke the
  latest published contents with a separate private editor bearer token that never appears in the link.
- **Web now, native later.** We build a responsive web app first, behind a clean data API so a
  native client can reuse the same core later.

## How these docs are organized

Read [Vision & Scope](./vision.md) for what we are (and aren't) building, then
[Architecture Overview](./architecture.md) for the shape of the system. The remaining chapters
drill into data sources, the map UI, durable identity, the data model, sharing, storage/sync, the
concrete tech stack, and a phased roadmap.
