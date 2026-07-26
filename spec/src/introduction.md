# Introduction

**Placemarks** (working title) is a **blog platform with a heavy geolocation focus**, built
around open maps and portable user data. Think of it as *your own map turned blog* — import
places from the tools you already use, group them into curated lists, add notes, and publish
editorialised **posts** that pair prose with a live map.

It is deliberately **not** a full-featured places platform. We don't scrape reviews, we don't
run a social feed, and we don't try to replicate Google Places. Instead we do three things well:

1. **Interop** — Google Maps import/export is the basic building block: places arrive by import
   (Takeout, KML, GPX, GeoJSON), and hand back out as exports and navigation deep links.
2. **Curation** — group places into **lists** (the home screen), tag them, write notes, and edit
   lists directly or from the map, where every list's points wear its unique marker.
3. **Editorial** — write **posts** about lists, embedding their places into an article read
   beside a synchronized map, and share lists and posts as read-only links. OSM supplies just
   enough live place info — importantly, a **website link** when one exists.

## Principles

- **Open live data.** Map tiles, live geocoding, and live place metadata come from OpenStreetMap
  and OSM-derived services. User-exported files may contribute private imported facts, kept
  technically separate from OSM observations. Wrong or missing public facts are corrected
  upstream in OSM; Placemarks does not maintain a competing global POI layer.
- **Durable identity.** Personal content joins through an app-owned place id. The linked OSM
  element may be conservatively re-resolved from copied source evidence if OSM changes shape.
- **Local-first, synced.** Your owned data lives on your device and edits commit locally. No
  account is required for solo use; an optional account adds background multi-device sync
  (in v1 since 2026-07-19). Live search, OSM refresh, publishing, sync, and uncached maps still
  need connectivity.
- **Read-only sharing.** A public list or post URL is read-only. Its creator can update or revoke
  the latest published contents with a separate private editor bearer token that never appears in
  the link.
- **Web now, native later.** We build a responsive web app first, behind a clean data API so a
  native client can reuse the same core later.

## How these docs are organized

Read [Vision & Scope](./vision.md) for what we are (and aren't) building, then
[Architecture Overview](./architecture.md) for the shape of the system. The remaining chapters
drill into data sources, the lists-home and map views, durable identity, the data model, notes,
posts, import/export, sharing, storage/sync, the concrete tech stack, and a phased roadmap.

**Each chapter describes only the current design.** How and why it changed lives in
[Decisions](./decisions.md), which is non-normative: where the two disagree, the chapter is right.
That separation is deliberate — this book was previously append-only, and the code grew to be the
union of every design it had ever described.
