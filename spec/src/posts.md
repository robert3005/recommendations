# Posts — the Editorial Layer

> **Decision (2026-07-19, the lists-and-posts pivot).** The editorial layer detaches from `List`
> into a standalone **`Post`** entity. The 2026-07-18 design ("a guide is an editorialised list")
> folded prose into the list itself, which mixes two lifecycles into one entity: a list is
> **working curation** — membership, order, a marker — that keeps changing as places come and go,
> while an editorial piece is a **document about** places, written, revised, and published on its
> own schedule. Placemarks is a blog platform with a heavy geolocation focus: **lists curate,
> posts editorialise.** The block machinery designed for the guide layer (ranked blocks, note
> attachments, tag selections) is exactly the post structure; the pivot relocates it, it does not
> reinvent it. The word **guide** is retired: dated rulings elsewhere in this spec that say
> "guide" describe what is now a published list or a post.

**The post is the guide: an editorialised list.** A post is an article about exactly one list — a
titled, ordered sequence of Markdown prose sections and **place embeds** drawn from that list's
members. It reads like a blog post; because every embed is anchored to a physical location, the
article renders beside a synchronized map. A list may have several posts (a shortlist and a full
write-up, say); the list page links to its posts and every post links back to its list.

## Model

Entity definitions live in the [data model](./data-model.md#post-an-editorialised-list); the shape
in brief:

```text
Post ──1:*── PostBlock ── section ──▶ Note (target: post)
                │
                └─ place ──▶ PlaceId  ─ * BlockNoteAttachment ──▶ shareable place Note
                                      └ * BlockTagSelection  ──▶ Tag
```

- A **section** block is a post-targeted Markdown note — a narrative passage between embeds.
- A **place** block embeds a member of the post's list: the card shows the place's display facts,
  attached shareable place notes, explicitly selected tags, and the navigation deep links.
- Blocks order by `(rank, id)` with the same fractional-rank rebalancing as list blocks.
- `listId` names the one list the post editorialises. The post wears that list's marker on its
  map, the list page lists its posts, and the post page links back to its list — locally and in
  the shared document ([Publishing](#publishing)).

## Where embeds come from

A post embeds **members of its list** — the post is that list's editorial layer, not a scrapbook
over the whole library. Embedding a place that is not yet in the list goes through the one door
that exists: the editor offers to **add it to the list first** (`addToList` — membership is
existence), then embeds it. This is also how a post is written from the map: tap a pin, add it to
the list, embed it.

**Bottom-up teardown** (ruling, 2026-07-19, late — supersedes the same-day embed-tombstone and
detached-post rulings, and retires the implemented pre-pivot deletion cascades at Phases 6–7).
Deletion never cascades through authored content; it is **refused until the owner has explicitly
dismantled what hangs off the target**:

- Removing a place from a list is refused while a live post about that list embeds it — remove
  the embed from the post first. The embed-references-a-member invariant holds by prerequisite,
  not by a tombstone cascade that would leave gaps in an article.
- Removing a place from its **last** list — the removal that deletes the place
  ([membership is existence](./data-model.md#membership-is-existence-no-saves)) — is refused
  while the place carries live notes: the owner deletes their own notes first. Tag assignments
  and other pure edges cascade; written content never does.
- Deleting a list is refused until it is **empty** and no live posts editorialise it — remove
  the places (or bulk **Remove all places** in Edit mode, which names any blockers: places with
  notes, places embedded in posts) and delete the posts first.
- Deleting a post is itself the explicit act: its blocks, its own section notes, attachments,
  and selections go with it; the list, its places, and place notes are untouched.

Every refusal is actionable: the dialog names the blockers and links to them. Already-published
revisions are unaffected by any of this until the author republishes — the public document
carries its own copied evidence.

## Authoring

- The post editor is a **block editor**: insert, remove, and reorder prose sections and place
  embeds — the same rank-based interaction as list Edit mode.
- Prose sections open the same **full-screen Markdown editor** as place notes
  ([Notes & Rich Content](./notes.md)); the persisted format is the Markdown source.
- The embed picker sources from two directions: browse a list and pick places, or pick from the
  map — tapping a library pin offers **Embed in post** alongside the place card's other actions.
- Nothing in a draft post leaves the device; publishing is the explicit, previewed step it is for
  every public projection.

## Reading

The post page renders in the app's one layout grammar
([Views](./map-view.md#the-grammar)): the article in the content pane, the post's embeds on the
persistent map canvas wearing its list's marker. **The map follows the article** — scrolling to
a section or embed flies the camera to its places (instant recenter under
`prefers-reduced-motion`), and selection links text ↔ pin in both directions. Expanding the pane
gives distraction-free reading — the hidden canvas [idles](./map-view.md#the-grammar), the
follow coalescing until reveal — and collapsing it gives the post's map. The public viewer
([Sharing](./sharing.md#public-viewer)) is the read-only rendering of the same page in the same
shell.

## Publishing

A post publishes through the existing machinery — the versioned block-document schema was designed
for exactly this shape:

- **Snapshot link** — the post document compressed into a URL fragment; no backend involved.
- **Hosted named link** — a public slug whose content only the holder of the private editor
  bearer token can update or revoke.

`Publication.target` gains `kind: "post"`. A shared **list** is the same document schema
restricted to place blocks; see
[one block document, two projections](./sharing.md#one-block-document-two-projections).

**A shared post stays associated with its list** (2026-07-19). The published post document names
its list and, when that list has its own hosted public link, carries the list's slug — the public
post page shows *"From the list: 〈name〉"* linking to the list's page, where a reader can grab the
raw list (read it, import it, export it). The publish preflight offers to publish the list
alongside the post when it isn't published yet; declining publishes the post with the list named
but unlinked. Revoking the list's page removes the link target — the next successful post publish
drops the dangling slug, and until then viewers see the list name without a working link (the
tombstoned slug is never reassigned, so the stale link can only 404, never point elsewhere).

## Standalone note pages, questioned

A published place-note page (`/n/<slug>`, Phase 5) is a micro-post: one prose body plus one place
context. The mechanism is implemented and remains valid, but posts are the editorial surface this
product is about. Ruling (2026-07-19): note pages are **not promoted in the UI**, gain no new
capabilities, and are a candidate for folding into posts (a one-place post) in a later
consolidation. The share-service protocol they use is unchanged.

## Migration from the guide layer

The implemented list-block machinery is the storage substrate the pivot renames:

- A list carrying section blocks, note attachments, or tag selections gets a same-titled **post**
  created from that editorial content, with `listId` pointing at that list; the list keeps only
  its place blocks. Lists with no editorial content — the overwhelming case — are untouched.
- List-targeted notes retarget to the created post (`NoteTarget` kind `"post"`); the retarget
  tombstones stale attachments per the existing repository rulings.
- A `Publication` targeting such a list follows the editorial content to the post. The hosted slug
  keeps serving the same document: the wire schema is unchanged, so no public link breaks.
