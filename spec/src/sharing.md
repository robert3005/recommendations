# Sharing & Publishing

Every list and every post can be published as a read-only public page. Publishing is the only
remote act in Placemarks: all editing is local, and nothing is public until its owner presses
Publish. A published page is then **live** — it follows its source, each change a new version —
unless the owner switches it to manual. No account exists on either side — the owner holds a
per-publication secret, and a reader just follows a link.

## One sharing mode

There is exactly one way to share: a hosted, named, read-only page per published list or post.

```text
https://app.example/l/<slug>     a published list
https://app.example/p/<slug>     a published post
```

Slugs are public and guessable — a slug is not a secret and not a read-access token. A revoked
slug tombstones forever and is never reassigned, so an old link can never come to mean someone
else's content. The `/l` and `/p` prefixes deliberately avoid the local `/list` and `/post`
routes, because the viewer is the same web app on the same origin (see below).

## Explicit publish

Nothing leaves the device until the owner presses **Publish** (on a list: **Share this list**),
and **Unpublish** revokes the page. Before anything is sent, a publish preview shows exactly
what leaves: the title, the curator's name and the intro, the places with their coordinates —
each with the note, tags and rating that will go with it — and the body. A list's own posts are
offered for publishing alongside, ticked; the owner unticks what should stay private. The
preview says that the page will be live.

Publish and unpublish are foreground actions: each visibly succeeds or fails in the UI, and
retrying means pressing the button again. Publishing needs the network and says so when it is
absent.

## Live pages

After its first publish a page is **live**: when its source changes — a place added, a note
edited, the intro rewritten, an entry reordered — the app republishes it on its own once the
edits have settled for a few seconds. This is the one thing that leaves the device without a
press, and it only ever sends a newer version of something the owner already chose to publish.

- **Versions.** Every publish carries a version number — 1 on the first, one more on each
  update — and the time of that version. The public page shows both. Versions count changes;
  earlier versions are not kept.
- **Behind, not queued.** "Behind" is a comparison: the hash of the current projection against
  the [`Publication`](./data-model.md) row's `lastPublishedHash`. The version stamp is not part
  of the hash, so an unchanged page is never behind. There is no outbox: a page that could not
  be updated (offline, rate limited) simply stays behind, shows "updating…", and is tried again
  on the next change or when the network returns.
- **Manual.** Each page has **Update the page automatically**, on by default. Switched off, the
  page changes only on **Publish update**, and shows "unpublished changes" until then.
- **Only this device.** A page whose editor token is not on this device is never touched.

## The curator's voice

A shared list is a recommendation, so it carries the person recommending:

- the **curator's name** ("Curated by …"), set once in Settings and optional;
- the list's **intro**;
- per place, the owner's **note**, **tags** and **rating** — unless the list opted out
  (**Include my notes, tags and ratings**, in the preview). A note is personal, which is why the
  preview shows every one before anything is sent.

Post documents never carry the owner's notes: a post says what it says in its body.

## The editor token

Each publication has one editor token, generated at its first publish from at least 256 random
bits and stored on the local `Publication` row. It is sent as a Bearer header over TLS, stored
server-side only as a hash, compared in constant time, and never appears in a URL or in a
published document. Whoever holds the token can update or revoke that one publication; nobody
else can.

**Token loss is permanent.** After storage eviction, a restore without credentials, or a lost
device, the page can no longer be updated or revoked through the API. The recourse is to
republish under a new slug, and to have the stale page removed through the service's
operator-mediated takedown contact. The UI states this plainly wherever tokens are at stake, and
[Local Storage](./storage.md) repeats it for backups.

## Teardown

Deleting a published list or post is refused until the owner unpublishes it — no public page is
ever orphaned by a local delete. Revoked `Publication` rows persist locally as tombstones.
Publishing again after a revoke creates a new publication under a new slug; a tombstoned slug is
never reused.

## Published documents

A published document is self-contained: it embeds every fact the public page needs — including
the enriched place facts (website, phone, opening hours, cuisine, wheelchair access, the
description, and its Wikipedia link) — keyed by the place's `PlaceId` so mentions rewrite to
stable fragments. The viewer renders exactly what was published and never re-resolves. `OsmRef`
and `ListMarker` are the types from the [data model](./data-model.md).

```ts
interface PublishedPlace {
  id: string;                 // the PlaceId — the stable key mentions rewrite to
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  cuisine?: string;
  website?: string;           // https only, enforced by the schema
  phone?: string;
  openingHours?: string;      // the raw opening_hours tag value
  wheelchair?: string;        // "yes" | "limited" | "no"
  description?: string;       // OSM description tag or Wikipedia summary, as captured
  wikipediaUrl?: string;      // the source article — the viewer's "Wikipedia" credit target
  note?: string;              // the curator's layer — lists only, and only when shared
  tags?: string[];
  rating?: 1 | 2 | 3;
  osmRef?: OsmRef;            // attribution + OSM deep link on the public page
  imageUrl?: string;          // https + Wikimedia hosts only, enforced by the schema
}

interface PublishedStamp {
  version?: number;           // 1 on first publish, +1 per update — never part of the hash
  updatedAt?: string;         // ISO time of this version
}

interface PublishedList extends PublishedStamp {
  v: 1;
  kind: "list";
  title: string;
  marker: ListMarker;
  description?: string;       // the curator's intro
  author?: string;            // the curator's display name
  places: PublishedPlace[];   // list order
  posts?: Array<{ title: string; url: string }>;  // published posts about this list
}

interface PublishedPost extends PublishedStamp {
  v: 1;
  kind: "post";
  title: string;
  body: string;               // Markdown, links rewritten at publish (below)
  places: PublishedPlace[];   // the post's projection at publish time
  list?: { title: string; url?: string };  // list posts only; url when the list is published
}
```

A published **place post** carries no back-link — `list` is for list posts only. A published
list's `posts` array links the published posts about it: the public edition of the list page's
posts sidebar ([The notebook & the map](./map-view.md)).

## Publish-time link rewrite

Post bodies use `place:` and `post:` links locally ([Posts](./posts.md)); published bodies never
contain them. At publish time:

- `place:<placeId>` → `#place-<placeId>` when that place is in the published `places` set, else
  the link renders as plain text.
- `post:<postId>` → the target's public URL when the target is published, else plain text.

The publish preflight offers to publish linked-but-unpublished posts (and a list post's list)
alongside. The viewer maps `#place-<id>` fragments to pin focus; it never sees `place:`/`post:`
protocols, and its sanitizer allowlists only `http:`/`https:` links and `#` fragments.

## The public viewer

The viewer is the same deployed web app: `/l/:slug` and `/p/:slug` are SPA routes that fetch the
published document from the share service and render it read-only in the notebook+map shell
([The notebook & the map](./map-view.md)). There is no live OSM resolution and no import — a
published page renders exactly what was published, as of its latest version; an open page
refetches on return to the tab and about once a minute. Pages are `noindex` by
default and carry ODbL attribution when any published place has an `osmRef`. The service serves
documents, never pages.

## The share service

The share service is the only backend: Hono on Cloudflare Workers with D1, two tables
(`documents` and `rate`). The protocol, in full:

- `PUT /s/lists/:slug` and `PUT /s/posts/:slug` — Bearer; create-or-update. The first PUT claims
  the slug and binds the token hash (201); later PUTs with the same token replace the document
  (200); a PUT with a different token is 403; a tombstoned slug is 410. The client proposes a
  slug derived from the normalised title and walks `-2…-9` suffixes on both 403 (owned by
  another token) and 410 (tombstoned — including the owner's own earlier revoke); if all are
  taken, publish fails visibly.
- `GET /s/lists/:slug`, `GET /s/posts/:slug` — public; ETag plus a short `s-maxage` (~60 s); on
  update or revoke the worker purges that single URL.
- `DELETE …/:slug` — Bearer; tombstones the slug. Repeating a DELETE is 204 — idempotent by
  nature.

Documents are schema-validated; requests are subject to size and rate limits; slugs are
normalised and reserved names rejected. The service maintains an abuse/takedown path — which is
also the recourse after token loss.

## Privacy

Only explicitly published projections ever leave the device, and the publish preview is the
exact disclosure of what does — including that the page is live, so later edits to that list or
post go out as they are made until the owner switches the page to manual or unpublishes it.
Everything added to the published fields after the first schema (intro, author, notes, tags,
rating, the version stamp) is optional, so documents published before them still validate. Unpublish removes the hosted document, but the honest boundary
stands: copies already downloaded and third-party caches cannot be remotely erased, and the UI
says so next to the unpublish control.
