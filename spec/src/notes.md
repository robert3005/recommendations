# Notes & Rich Content

Notes are rich Markdown pages anchored to either a place or a [post](./posts.md). A place note is a
write-up about a durable `PlaceId`; a post note is a narrative section of the post's article.

**A note's target is immutable.** Prose that belongs to another place or post is created there.

A place note is private by default and may be selected for a read-only shared list or post. A post
note is part of its post's article and publishes with it.

## Markdown as the source of truth

We store CommonMark + GFM Markdown, not HTML.

- **Portable and durable** — plain text survives backup, import, sync, and renderer changes.
- **Controlled rendering** — raw HTML is disabled and generated HTML is sanitized.
- **Conflict-friendly** — a text source can be compared and preserved when concurrent edits occur;
  the sync layer keeps a conflict copy rather than silently discarding one body.
- **Flexible authoring** — a future WYSIWYG editor can still serialize to Markdown.

GFM headings, emphasis, lists, task lists, tables, blockquotes, code, links, and images cover the
post-writing use case without inventing a proprietary document format.

## Authoring

Notes are edited in a **full-screen editor** (2026-07-18): a Markdown writing surface beside a
live, sanitized preview — never a cramped inline box. The editor's output *is* the persisted
Markdown source; a future WYSIWYG upgrade must keep serializing to Markdown. Optional fields obey
normal replacement semantics: clearing a note title removes it rather than retaining the previous
value.

## Rendering pipeline

```text
Markdown → CommonMark/GFM parser → HTML → sanitizer → safe rendered content
                                            ↑
                                  resolve approved asset: ids
```

- Use a maintained parser such as `markdown-it` or `remark`/`rehype`.
- Raw HTML is disabled; output is still sanitized with DOMPurify or `rehype-sanitize`.
- Links allow only approved schemes. External links use `rel="noopener noreferrer nofollow ugc"`.
- Remote Markdown images are blocked. Images must use an `asset:` id controlled by the app.
- Both URL transformation and the sanitizer protocol allowlist explicitly permit `asset:` only for
  image sources. The renderer resolves that id to a local/hosted object URL; sanitization must not
  erase an approved local image before the resolver component sees it.
- The app and public viewer share the same parser, sanitizer, and Content Security Policy.

## Images and media

Image import REQUIRES the canvas re-encode (WebP,
EXIF/location stripped). Where no re-encode path exists or decoding fails, the import is
rejected — the original bytes (and their embedded location) are never retained.

Markdown references images through stable asset ids:

```markdown
![Sunset from the terrace](asset:med_9f3a1c)
```

| Context | Resolution |
|---|---|
| Authoring/offline | Local object URL backed by the IndexedDB media blob |
| Hosted list/post | Not yet supported — hosted views carry a text placeholder |
| Snapshot link | Text placeholder; no media is included in a no-backend snapshot |

On import, the client checks type and size and downscales large images. Before hosting, the media
service validates magic bytes, rejects SVG, enforces byte/dimension quotas, decodes and re-encodes
the image, and strips EXIF/location metadata. Hosted media is served from a cookieless origin with
a restrictive CSP; shared documents never supply arbitrary image URLs.

Media upload/deletion requires the same publication editor bearer token, and the service verifies
publications. Revoking the final public reference schedules deletion after a documented recovery
window and purges CDN entries within the service target; the private local asset remains until the
owner deletes it. Already-downloaded copies cannot be remotely erased.

## Share eligibility versus publication

`Note.shareable = true` makes a **place** note eligible for selection into a public projection; it
does not mean the note is currently public. Actual attachment to a post embed is stored in
`BlockNoteAttachment`.

Turning `shareable` off:

1. prevents the note from entering new public projections;
2. marks every hosted publication containing it dirty;
3. leaves the previous public revision visible until the update succeeds.

This makes delayed or offline revocation explicit, rather than pretending a local boolean instantly
removes bytes already published elsewhere.

The flag does not apply to post notes: a post's prose publishes because the post publishes.

## No standalone note page

A note has no public page of its own. It reaches the world inside the list or post that carries it,
and a note worth publishing alone is a one-embed post — a strictly richer page for the reader.

The `/n/<slug>` surface and the `/s/notes` collection existed and were removed on 2026-07-26: this
book had already declined to promote them, and they were the only publication kind whose document
embedded its own slug, which cost the share service two special cases and the client a slug rewrite
inside its collision walk. See [Sharing](./sharing.md) for the two collections that remain.

## How notes build a post

- A post note appears as a `section` block between place embeds.
- A place note attaches through a `BlockNoteAttachment` and renders inside that embed's card.
- Short place notes may render inline; longer ones can collapse behind “read more.”

Post publishing includes a live section block's matching shareable post note and live
`BlockNoteAttachment` place notes. Other notes on the same place or post never leave the device.
