# Local Storage

The library lives on the device: IndexedDB, accessed through Dexie, is the durable primary store.
Local reading and editing never require an account or a network round trip. Publishing is the only
remote act — see [Sharing & Publishing](./sharing.md).

## Object stores

One store per entity in the [data model](./data-model.md), plus a key-value store for UI state:

- `places`, `lists`, `listEntries`, `posts`, `publications`, `importBatches`, `importItems`.
- `settings` — small key-value data: the home map toggles and the last viewport.

There is one schema version until something ships; migrations begin when real libraries exist.

## Repository invariants

Domain writes go through repository transactions, which enforce the model's invariants in the same
transaction that performs the write:

- **Membership is existence** — a place exists iff it is in at least one list; every creation path
  ends by adding the place to a list, and removing its last entry deletes the place.
- **One live `(listId, placeId)` pair** — a place appears at most once per list.
- **Marker uniqueness** — shape and colour pairs are unique across live lists up to the 64-pair
  space; beyond that, pairs repeat as deterministic numeral-badged variants.
- **The three teardown refusals** — deleting a place is refused while posts target it; deleting a
  list is refused until it is empty and its posts are deleted; deleting a list or post with a live
  publication is refused until it is unpublished.
- **Post-target existence** — a post's target list or place must exist when the post is created.

## Offline behaviour

The service worker precaches the app shell, so an already-installed app opens offline. All local
reading and editing works from IndexedDB. Pasted map links are parsed, never fetched, so link
paste works offline too — except the OSM element lookup, which needs the geocoder: it fails
politely, nothing queues, and the user retries online. The UI states capability per surface:

| Capability | Offline behaviour |
|---|---|
| Read and edit places, lists, entries, and posts | Works from IndexedDB |
| Paste a Google Maps or Apple Maps link | Works — parsed locally |
| Paste an OSM element link | Fails politely; retry online |
| Search and geocoding (add-a-place, import ladder) | Needs the network and says so |
| Map tiles | Need the network and say so |
| Publish, update, or unpublish | Needs the network and says so |

## Eviction honesty

The browser may evict or clear IndexedDB. The app requests persistent storage where supported,
surfaces quota errors rather than failing silently, and periodically prompts the user to export a
library archive — the id-preserving backup described in [Import & Export](./interop.md). Editor
tokens are included only in a credentials-included export: a routine archive restores the library
but not publish control, and the prompt says so.

## What is remote

Published documents. Nothing else. There is no sync and there are no accounts: two devices are two
libraries, and the library archive is what moves one to the other. Publish control moves only
inside a credentials-included export — a device restored without credentials sees its publications
but cannot update or revoke them (see [Sharing & Publishing](./sharing.md) for token loss).
