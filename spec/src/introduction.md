# Introduction

**Placemarks** is a personal atlas: import the places you've saved elsewhere, curate them into
marked lists, write posts about the places and lists, and publish any list or post as a
read-only page. Everything is edited locally; publishing is the only remote act.

The loop is short and deliberate. Places arrive by import — paste a Google Maps, Apple Maps, or
OSM link, or bring whole lists in from a Google Takeout archive. They are curated into
**lists**, each wearing a unique marker (a shape and colour pair) so several lists can overlay
the map at once and stay legible. **Posts** are Markdown articles about one list or one place,
written and read beside a map of the places they cover. When something is worth showing, the
owner publishes it as a hosted read-only page and hands out the link.

Placemarks is deliberately not a places platform. There is no social feed, no review scraping,
and no attempt to replicate Google Places — just import, curation, editorial, and a share link.

## Principles

- **Local-first, with no accounts.** The library lives on the device and every edit commits
  locally. Remote state is published documents, plus — only if the owner turns sync on — an
  encrypted copy of the library that keeps their devices in step
  ([Sync Between Devices](./sync.md)).
- **Open data.** Map tiles and geocoding come from OpenStreetMap-derived services, attributed
  under ODbL wherever OSM facts travel. No proprietary API calls and no scraping: pasted Google
  and Apple links are parsed, never fetched.
- **Explicit publish.** Nothing leaves the device until the owner presses Publish, and a shared
  link changes only when the owner publishes an update. Unpublish revokes the page.
- **Web-first.** A responsive web app built on one layout grammar — the notebook beside the
  persistent map canvas — on desktop and mobile alike.

## How these docs are organised

Read [Vision & Scope](./vision.md) for what is (and is not) being built, then
[Architecture Overview](./architecture.md) for the shape of the system. The remaining chapters
drill into the notebook-and-map UI, the visual design, the data model, posts, import and
export, sharing and publishing, local storage, map data and providers, the tech stack, and the
roadmap. Each chapter describes only the current design; how and why it changed lives in
[Decisions](./decisions.md), which is non-normative — where the two disagree, the chapter wins.
