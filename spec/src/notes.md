# Notes & Rich Content

Notes are rich Markdown pages anchored to either a place or a [post](./posts.md) (2026-07-19: the
pivot retargeted list notes to posts). A place note is a write-up about a durable `PlaceId`; a
post note is a narrative section of the post's article. A note is private by default, may be
selected for a read-only shared list or post, and may optionally be published as its own
read-only page at `/n/<slug>` (a surface [under question](./posts.md#standalone-note-pages-questioned)
since posts landed).

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

> **Implementation decision (2026-07-19).** Image import REQUIRES the canvas re-encode (WebP,
> EXIF/location stripped). Where no re-encode path exists or decoding fails, the import is
> rejected — the original bytes (and their embedded location) are never retained.

Markdown references images through stable asset ids:

```markdown
![Sunset from the terrace](asset:med_9f3a1c)
```

| Context | Resolution |
|---|---|
| Authoring/offline | Local object URL backed by the IndexedDB media blob |
| Hosted list/post/note | Server-issued media id on the trusted media origin |
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

`Note.shareable = true` only makes a note eligible for selection. Actual post attachment is stored
in `BlockNoteAttachment`; standalone publishing is stored in the private `Publication` entity.

Changing `shareable` to false:

1. Prevents the note from entering new public projections.
2. Marks every hosted publication containing it dirty.
3. Queues an updated list/post or note-page revocation.
4. Leaves the previous public revision visible until that network operation succeeds.

This makes delayed/offline revocation explicit instead of pretending a local boolean instantly
removes bytes already published elsewhere.

## Publishing a note page

The page URL is public and read-only. A separate private editor bearer token lets only the creator
update or unpublish it; the token never appears in the URL or `SharedNote`.

```ts
type SharedNoteContext =
  | { kind: "place"; place: SharedPlaceAnchor }
  | { kind: "post"; postTitle: string };   // pre-pivot documents carry { kind: "list"; listTitle }

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

Place context uses [`SharedPlaceAnchor`](./sharing.md#shared-document-schema): the current OSM
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

> **Implementation decisions (2026-07-19, Phase 5).**
>
> - **Hosted media is deferred.** Until the media service exists, `media` stays empty and the
>   share service rejects (`422`) any document claiming a `hostedMediaId` — ids must be issued
>   server-side, bound to a publication and token. Note bodies keep image placeholders.
> - **The document's slug is its URL.** `POST /s/notes` rejects a `SharedNote` whose `slug`
>   disagrees with `desiredSlug`; when the client walks slug collisions it rewrites the embedded
>   slug per candidate, so the stored document always names its own public address.
> - **Failed updates never hide the page.** The last published revision stays public and the
>   creator UI keeps the page link with explicit *Update* (retry) and *Unpublish* actions
>   alongside the surfaced error.
> - **Viewer honesty about the place context.** Copied evidence renders with its observation date;
>   a confirmed-missing OSM element says so explicitly ("no longer found on OpenStreetMap —
>   showing saved facts"); a manual anchor is labelled owner-added/unlinked and carries no OSM
>   attribution claim.
> - **Guides and pages update together.** Editing a shareable note (or making it private) queues
>   every hosted guide containing it as well as the standalone page — one edit, every affected
>   public projection marked, none auto-published.
> - **Deletion and privacy precedence.** Deleting a note (directly or through a list/place
>   cascade) queues revocation of its standalone page, and making a note private deletes its
>   pending publish jobs — the revocation supersedes every unsent page update.

## How notes build a post

- A post note appears as a `section` block between place embeds.
- A place note attaches through a `BlockNoteAttachment` and renders inside that embed's card.
- Short place notes may render inline; longer ones can collapse behind “read more.” If the note has
  its own page publication, that action may link to `/n/<slug>`.

Post publishing includes a live section block's matching shareable post note and live
`BlockNoteAttachment` place notes. Other notes on the same place or post never leave the device.
