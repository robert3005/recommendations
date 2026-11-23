# Sync Between Devices

A library can live on a phone, a tablet and a computer at once. Sync is **off until its owner
turns it on**, has **no account**, and the service that carries it **cannot read it**: the
library is encrypted on the device with a key the service never sees. Everything stays
local-first — every edit commits to the device immediately, and sync catches the other devices up
when it can.

This is deliberately small. The service is the [share service](./sharing.md) with four more
routes and two more tables; the merge is the archive restore's rule, run continuously; there is
no outbox, no logical clock and no conflict copy to resolve by hand.

## What syncs

Places (facts, and the owner's tags, note, rating and status), lists and their entries, saved
views, posts, and publication records — including each page's editor token, sealed like the
rest, so any paired device can update or unpublish a page.

Staying on each device: import working state, the review-insights store (third-party data,
loaded from a folder — [Review Insights](./reviews.md)), the map camera and layer toggles, and
the name shown on shared pages.

## The library key

Turning sync on makes a **library key** — 256 random bits — on that device. A person sees it as
a 43-character code. Four values are derived from it (HKDF-SHA-256), each for one purpose, so
none reveals another:

| Derived | Used for | Who sees it |
| --- | --- | --- |
| library id (128 bits) | which library on the service | the service; unguessable |
| service token (256 bits) | the Bearer secret on every request | the service stores only its hash |
| encryption key (AES-256-GCM) | sealing each row | never leaves a device |
| row key (HMAC-SHA-256) | turning `<table>:<id>` into an opaque row name | never leaves a device |

The key is stored on the device beside the library, like a publication's editor token. It is
never part of an exported archive.

**There is no recovery without the key.** With no account there is nobody to ask: a library
whose every device is lost is recovered only with the code, or from an exported archive. The
interface says this where the code is shown.

## Pairing

- **Turn on sync** makes the key, claims the library on the service, sends the library, and
  shows the code — as text and as a QR of a pairing link.
- **A second device joins** by scanning the QR with its camera or by pasting the code in
  Settings. The pairing link is `/settings#pair=<code>`: the code rides in the URL fragment,
  which a browser never sends to a server; the app fills the join field from it, removes it from
  the address bar, and waits for the owner to press **Join**. Nothing joins on its own.
- A well-formed code that opens no library is refused — it never quietly starts a new, empty
  one.
- A device that joins with places of its own keeps them: they merge into the library and go to
  the other devices.
- **Stop syncing on this device** keeps the library here and on the service. **Delete the
  synced copy** removes it from the service; every device keeps its own library and is told the
  synced copy is gone.

The code is the key: anyone holding it can read and change the library. It is for the owner's
own devices.

## The service

Four routes beside the publishing ones, all requiring the library's Bearer token. Nothing here
is public and nothing is cached.

```text
PUT    /y/:library           claim (201) or confirm (200); 403 for another token
POST   /y/:library/rows      upsert rows — each takes the library's next sequence number
GET    /y/:library/changes   rows after ?since=N, ascending, paged, with a cursor
DELETE /y/:library           remove the library and its rows (204, repeatable)
```

A row is `{ k, c }`: the opaque row key and `base64(iv ‖ ciphertext)`. The service's one job
beyond storage is **ordering**: every write gets the library's next sequence number, so a device
that asks for "everything after N" gets a complete, ordered answer and keeps the last number as
its cursor. The service validates shape and size, rate-limits per library and source, and caps
rows per library. It never parses a row, and it does not merge: two devices writing the same row
simply leave the later arrival stored, and each device's own merge decides what the row should
be.

Two tables: `libraries (id, token_hash, created_at, seq)` and
`sync_rows (library_id, k, c, seq)`.

## Merging

Merging happens on the device, by three rules (the pure functions in
`packages/domain/src/sync.ts`).

1. **A row is last-writer-wins** by `updatedAt` — the rule the archive restore already uses. Two
   different rows stamped the same instant are ordered by their content, which is arbitrary but
   identical on every device, so they still agree.
2. **A place's own tags merge as a set.** Each tag put on or taken off is stamped with its time
   (`Place.tagLog`), and two copies merge tag by tag, the later stamp standing. A tag added on
   the phone and another added on the laptop both survive, and a tag removed on one device is
   not brought back by an older copy on the other. Every other field of the place follows
   rule 1. When neither copy is the answer, the merged place is written with a new `updatedAt`
   and sent back out.
3. **A deletion is a marker.** Rows are hard-deleted locally, so each deletion of a synced row
   leaves a tombstone — `<table>:<id>` and the time — written in the same transaction. A
   deletion stands against a row unless the row was edited after it; an edit made after a
   deletion elsewhere brings the row back on every device.

Two more cases:

- Two devices that each put the same place on the same list made two entries. Both collapse
  them the same deterministic way — the `(rank, id)`-first entry stays — so the devices agree
  without negotiating.
- A device that holds a page's editor token never loses it to a copy of the publication that
  lacks one.
- A place or saved view from a device on a build before five-star ratings arrives with a
  three-step `rating` or `minRating`; it is upgraded to `stars` / `minStars` before it is merged
  ([Data Model](./data-model.md) §Normative rules).

The clock is the device's wall clock. A device whose clock is far wrong can win or lose an edit
it should not have; that is accepted for a personal library, and is why tags — the one thing
people plausibly edit on two devices before syncing — do not depend on whole-row ordering.

**Known limit:** the same real place saved separately on two devices *before* they were paired
arrives as two places, because each device gave it its own id. The duplicate prompt covers
saving it twice on one device; nothing yet merges two across devices.

## The cycle

One cycle is *pull, merge, push*:

1. Pull everything after this device's cursor, open each row, and merge the page in one
   transaction. The cursor moves only after its page is merged. A row that cannot be opened, or
   is filed under the wrong row key, is skipped, never trusted.
2. Push every local row whose stamp differs from what this device last exchanged for it —
   deletion markers included.

**Nothing is queued.** "What is waiting to be sent" is recomputed from the library each cycle
(`syncState` records, per row, the stamp last exchanged), so a cycle that fails half-way loses
nothing: the next one starts from where the library says things stand.

A cycle runs when the app opens, when the network returns, when the tab comes back into view,
about once a minute while it stays in view, and a few seconds after something on the device
changes. Offline is not an error state the owner must clear: changes are kept and go when the
network is back.

## Privacy

With sync on, the whole library goes to the service — sealed. The service learns how many rows a
library has, how large each is, and when devices write; it does not learn a place, a name, a
note or a tag, nor which rows are places. Turning sync off is immediate on a device; **Delete
the synced copy** removes the ciphertext from the service.
