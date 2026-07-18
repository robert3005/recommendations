# Notes & Rich Content

Notes are rich Markdown pages anchored to either a place or a list. A place note is a write-up about
a durable `PlaceId`; a list note is a narrative section in a [guide](./data-model.md#list-a-rich-guide).
A note is private by default, may be selected for a read-only shared guide, and may optionally be
published as its own read-only page at `/n/<slug>`.

## Markdown as the source of truth

We store CommonMark + GFM Markdown, not HTML.

- **Portable and durable** — plain text survives backup, import, sync, and renderer changes.
- **Controlled rendering** — raw HTML is disabled and generated HTML is sanitized.
- **Conflict-friendly** — a text source can be compared and preserved when concurrent edits occur;
  the sync layer keeps a conflict copy rather than silently discarding one body.
- **Flexible authoring** — a future WYSIWYG editor can still serialize to Markdown.

GFM headings, emphasis, lists, task lists, tables, blockquotes, code, links, and images cover the
guide-writing use case without inventing a proprietary document format.

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
- The app and public viewer share the same parser, sanitizer, and Content Security Policy.

## Images and media

Markdown references images through stable asset ids:

```markdown
![Sunset from the terrace](asset:med_9f3a1c)
```

| Context | Resolution |
|---|---|
| Authoring/offline | Local object URL backed by the IndexedDB media blob |
| Hosted guide/note | Server-issued media id on the trusted media origin |
| Snapshot link | Text placeholder; no media is included in a no-backend snapshot |

On import, the client checks type and size and downscales large images. Before hosting, the media
service validates magic bytes, rejects SVG, enforces byte/dimension quotas, decodes and re-encodes
the image, and strips EXIF/location metadata. Hosted media is served from a cookieless origin with
a restrictive CSP; shared documents never supply arbitrary image URLs.

Media upload/deletion requires the same publication editor bearer token, and the service verifies
that every hosted media id is bound to that publication. References are counted across hosted
publications. Revoking the final public reference schedules deletion after a documented recovery
window and purges CDN entries within the service target; the private local asset remains until the
owner deletes it. Already-downloaded copies cannot be remotely erased.

## Share eligibility versus publication

`Note.shareable = true` only makes a note eligible for selection. Actual guide attachment is stored
in `BlockNoteAttachment`; standalone publishing is stored in the private `Publication` entity.

Changing `shareable` to false:

1. Prevents the note from entering new public projections.
2. Marks every hosted publication containing it dirty.
3. Queues an updated guide or note-page revocation.
4. Leaves the previous public revision visible until that network operation succeeds.

This makes delayed/offline revocation explicit instead of pretending a local boolean instantly
removes bytes already published elsewhere.

## Publishing a note page

The page URL is public and read-only. A separate private editor bearer token lets only the creator
update or unpublish it; the token never appears in the URL or `SharedNote`.

```ts
type SharedNoteContext =
  | { kind: "place"; place: SharedPlaceAnchor }
  | { kind: "list"; listTitle: string };

interface SharedNote {
  v: 1;
  slug: string;
  title?: string;
  context: SharedNoteContext;
  body: string;
  media: Array<{ hostedMediaId: string }>;
  contentHash: string;
  publishedAt: string;
}
```

Place context uses [`SharedPlaceAnchor`](./sharing.md#shared-guide-document): the current OSM
reference plus copied recovery evidence. The viewer follows
[Durable Place Identity](./place-identity.md) and falls back to timestamped evidence when OSM or the
provider is unavailable.

The share service uses the same bearer-token and revision protocol as lists:

```text
POST   /s/notes
       Authorization: Bearer <editor-token>
       Idempotency-Key: <publication-job-id>
       { desiredSlug, document }
       → { slug, revision }
GET    /s/notes/:slug              → public read-only SharedNote + ETag
PUT    /s/notes/:slug              → Bearer + If-Match + Idempotency-Key required
DELETE /s/notes/:slug              → Bearer + If-Match + Idempotency-Key required
```

The client generates and persists the editor token before enqueueing `POST`; the server stores only
its hash. The creator's app references it through `Publication.credentialId`, queues updates in the
publication outbox, and shows the last successfully published revision. Public pages default to
`noindex` and disclose only the selected note, bounded place/list context, and approved media.

## How notes build a guide

- A list note appears as a `section` block between places.
- A place note attaches through a `BlockNoteAttachment` and renders inside that place card.
- Short place notes may render inline; longer ones can collapse behind “read more.” If the note has
  its own page publication, that action may link to `/n/<slug>`.

Guide publishing includes a live section block's matching shareable list note and live
`BlockNoteAttachment` place notes. Other notes on the same place or list never leave the device.
