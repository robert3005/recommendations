# Posts

A **post** is a Markdown article about exactly one list or one place. The target is set at
creation and is immutable; the writing can change forever, but what it is *about* cannot. A list
may have several posts (a shortlist and a full write-up, say), and a place may have several too.

Posts are the app's only long-form writing. What other apps call a "note" on a place is here a
**place post** — a place write-up *is* a post whose target is that place, with the same body
format, the same editor, and the same reading view as everything else. A **list post** targets a
list and reads as the article about that list. The entity shape lives in the
[data model](./data-model.md); this chapter covers creation, the body, authoring, reading, and
teardown.

## Creating a post

Each target kind has its own entry point:

- **New post**, in the list page's posts sidebar, creates a list post about that list and opens
  the editor.
- **Write a post**, on the place card, creates a place post about that place and opens the
  editor.

Takeout import creates place posts too: a CSV Note column is the user's own writing, and it
materialises as a place post titled with the place's name ([Import & export](./interop.md)).

## The body

The body is CommonMark plus GFM Markdown. The pipeline: remark-parse + remark-gfm →
rehype-sanitize with an allowlist schema; raw HTML disabled; the local app allowlists
`http:`/`https:`/`place:`/`post:` link protocols; external links get
`rel="noopener noreferrer nofollow"`. Published bodies contain no custom protocols (rewritten at
publish — see [Sharing & publishing](./sharing.md)); the viewer allowlists only `http:`/`https:`
and `#` fragments. Same parser and sanitizer everywhere.

### Link forms

Post body link forms: `[text](place:<placeId>)` — a mention; the map focuses that place.
`[text](post:<postId>)` — a cross-post link; this is how a list post links to place posts. Both
are soft: a dangling target renders as plain text.

Soft means soft everywhere: deleting a place or a post never hunts down the links pointing at
it. The article keeps reading as prose; only the link behaviour is lost.

### Projection

**Post projection** (one rule, all surfaces): a post projects its target's places — a list post
its list's members, a place post its one place. Mentions of places outside the projection render
as plain text (the editor only offers projected pins, so they arise only when a place later
leaves the list).

The projection is what the canvas shows beside the post, in the editor, the reading view, and
the public page alike.

## Authoring

The post editor (`/post/:id/edit`) is the split view of the one layout grammar
([The notebook & the map](./map-view.md)): a Markdown editor in the notebook beside the canvas
projecting the post's places — a list post shows all the places on its list, a place post its
one place. The map is not decoration; it is the palette the article is written from:

- **Pin to mention.** Tapping a pin inserts a mention of that place at the cursor.
- **Insert post link** opens a picker — for a list post it lists the place posts of the list's
  members first, then other posts — inserting a `post:` link. This is the authoring path for a
  list post that links out to its places' write-ups.
- **Preview** toggles the editor into the rendered, sanitised article in place — the same
  pipeline as the reading view, so what previews is exactly what renders.

Drafts are local like everything else; nothing a post says leaves the device until the owner
explicitly publishes it.

## Reading

The reading view (`/post/:id`) is the same split: the article in the notebook, the canvas
projecting the post's places. Selection links text and pins in both directions — selecting a
mention flies the camera to its place (instant under `prefers-reduced-motion`), and selecting a
pin scrolls the article to its mention. Cross-post links navigate to the target post's own
reading view.

The list page is the way in for list posts: its posts sidebar lists them, and selecting one
opens this view. A place's posts are reached the same way from its place card.

## Teardown

- Deleting a post is itself the explicit act, and it touches nothing else: the target list or
  place, its entries, and every other post are untouched. Inbound `post:` links elsewhere
  degrade to plain text — soft links never block anything.
- A post blocks its target's deletion the other way around: removing a place's last list entry —
  the removal that would delete the place — is refused while posts target it, and deleting a
  list is refused until it is empty and its posts are deleted. The owner deletes the writing
  first, deliberately; deletion never cascades through authored content.
- A post's publishing state — the shareable read-only page, unpublished-changes tracking, the
  refusal to delete a published post until it is unpublished, and the publish-time rewrite of
  `place:`/`post:` links into fragments and public URLs — lives in
  [Sharing & publishing](./sharing.md).
