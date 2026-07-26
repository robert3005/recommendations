# Storage & Sync

The app is **local-first**: domain writes commit to local storage first and do not require an
account or a network round trip. This does not mean every external-data feature works offline.
Search, uncached map areas, OSM refresh, media upload, and publication require connectivity.

## Local storage

IndexedDB, accessed through a thin wrapper such as [Dexie](https://dexie.org/), is the durable
primary store for the web client.

### Object stores

- `places` — app-owned `PlaceId`, current/historical OSM bindings, first-seen evidence,
  last-verified evidence, and resolution state.
- `notes`, `tags`, `tagAssignments`, `lists`, `listBlocks`, `posts`, `postBlocks`,
  `blockNoteAttachments`, and `blockTagSelections` — personal domain entities (2026-07-19:
  attachment/selection edges hang off post blocks; list blocks carry membership only). There is
  no saves store (2026-07-18: membership is existence — tag assignments and place blocks join
  directly on `PlaceId`).
- `media` — binary image blobs keyed separately from portable `MediaAsset` metadata.
- `publications` — private publication state, public slug, revisions, status, and a reference to a
  local credential.
- `credentials` — hosted-share editor bearer tokens; never included in public documents.
- `mutationOutbox` — durable local mutation ids drained by the sync transport.
- `publicationOutbox` — idempotent publish and revoke jobs.

There is no separate authoritative `poiCache`: `Place.lastVerified` is the durable display fallback
and identity evidence. A short-lived resolver response cache may exist for performance, but it is
rebuildable and cannot replace `Place` state.

Useful indexes include current and historical OSM reference, resolution state, `updatedAt`,
tag-assignment pairs, list-block `(listId, rank)`, place blocks by `placeId`, and publication
status. Ordered edges sort by `(rank, id)` and rebalance ranks deterministically. Repository
transactions enforce uniqueness and update dependent edges atomically.

## Repository and effect boundaries

The domain reads and writes a local repository. Network synchronization and publication are
separate effects rather than alternate repositories with different latency and failure semantics.

```ts
interface LocalRepository {
  transaction<T>(work: (tx: LocalTransaction) => Promise<T>): Promise<T>;

  getPlace(id: PlaceId): Promise<Place | undefined>;
  findPlaceByOsmRef(ref: OsmElementRef): Promise<Place | undefined>;
  /** Updates an existing membership-backed place; it is not a creation path. */
  updatePlace(place: Place): Promise<void>;

  /** Places currently in at least one list — membership is existence. */
  listPlaces(): Promise<Place[]>;
  addToList(listId: string, source: AddToListSource, now: string): Promise<Place>;

  listBlocks(listId: string): Promise<ListBlock[]>;
  upsertBlock(block: ListBlock): Promise<void>;

  enqueueMutation(mutation: LocalMutation): Promise<void>;
  enqueuePublication(job: PublicationJob): Promise<void>;
}

interface SyncTransport {
  push(mutations: LocalMutation[]): Promise<PushResult>;
  pull(cursor?: string): Promise<{ changes: RemoteChange[]; cursor: string }>;
}
```

Creating a place by adding it to a list, the guarded removals of bottom-up teardown (a place's
final removal with its tag assignments; an emptied list's deletion — the repository refuses a
removal whose prerequisites aren't met, in the same transaction that checks them), or changing a
post and queuing its publication are aggregate transactions. A failed network effect never rolls
back a committed local edit.

## Offline behavior

The app shell is cached from the first release so an already-opened installation can launch
offline. The UI exposes capability rather than using a blanket “offline capable” claim.

| Capability | Offline behavior |
|---|---|
| View/edit library places, tags, notes, lists, and posts | Works from IndexedDB |
| Multi-device sync | Mutations queue in the outbox; push/pull resume online |
| View stored OSM facts | Uses `lastVerified` evidence; freshness timestamps return with that surface |
| View previously cached map area | Best effort, subject to tile-provider policy/cache |
| Search or browse live POIs | Unavailable |
| Refresh or repair an OSM link | Queued until online |
| Create an OSM-backed library place | Requires a resolved OSM candidate and first list membership |
| Create an unlinked manual pin | Works fully offline |
| Publish, revoke, or upload media | Local change queues; public revision remains unchanged |

IndexedDB may be evicted or cleared. The app requests persistent storage where supported, surfaces
quota failures, explains device-local durability, and periodically prompts users to create a
backup. It never bulk-prefetches map tiles unless the selected provider explicitly permits it.

## OSM freshness and identity repair

the freshness UI (TTL refresh, Check for OSM updates,
stale/review states) is out of the v1 surface — see [The Map View](./map-view.md). The rules
below describe the design of record for when it returns.

OSM refresh is independent of private-data sync:

- A `resolved` observation older than its TTL becomes `stale` and refreshes in the background.
- The exact current OSM reference is always attempted before any candidate search.
- Offline, rate-limit, timeout, and provider failures become `unavailable`; they never trigger a
  relink.
- Only a confirmed missing/deleted or clearly repurposed element starts evidence-based recovery.
- Unique high-confidence replacement matches append link history; ambiguous matches require owner
  review.
- **Check for OSM updates** runs the same process on demand after an upstream edit.

See [Durable Place Identity](./place-identity.md) for the full state machine.

## Backup and restore

A backup is a versioned archive, not a single JSON file:

```text
placemarks-backup.zip
├── manifest.json             # schema version, per-entry checksums, counts, export metadata
├── data.json                 # owned entities + bounded attributed OSM identity evidence
└── media/<asset-id>.<ext>    # optional binary media
```

OSM-derived evidence is included because it is necessary to preserve place identity and offline
fallback. Evidence rows carry their observation timestamps; the manifest labels the archive's
export time, source attribution, and license. It contains a SHA-256 checksum for `data.json` and
every media entry. Ephemeral resolver caches are excluded. Export fails closed if a live
`MediaAsset` references missing or unreadable bytes; it never emits an apparently complete archive
with omitted media.

Before a transaction begins, import caps archive bytes, entry count, and inflated bytes; verifies
every declared checksum; rejects undeclared media; and validates schema, coordinates, ids,
references, and graph invariants. In particular, every live place must have a live list membership,
every place block must target a live place in its list, and media metadata must have matching bytes.
The entry-count cap also reads the ZIP central directory's own count — duplicate member names
collapse in a keyed extraction and must not undercount. Full-edge validation covers tag
assignments (live tag *and* live place, one live pair per place and tag) and every live note's
target. Merge validation applies last-write-wins tombstones *before* judging the final graph, so
an incoming deletion cannot smuggle an orphan through, checks attachments join a note and block
about the same place in the final state, and treats an incoming manual place reusing an existing
OSM place's id as an identity collision (linkage only ever gains OSM identity, never loses it).
The archive's declared bounds (central-directory entry count and uncompressed totals) are checked
before any decompression, and coalescing duplicate exact-OSM places grafts the dropped row's newer
last-verified (and older first-seen) evidence onto the retained place instead of discarding it.
A central directory that cannot be walked as declared is refused outright — never interpreted as
declaring zero. Export itself fails closed when the archive would exceed the restore caps: a
successful export is always restorable. Block note attachments restore only to shareable notes, and a
merged duplicate membership block hands its attachments to the retained block instead of leaving
them dangling.
The user chooses merge or replace. Merge uses the place-deduplication order from
[Durable Place Identity](./place-identity.md#import-and-deduplication): exact current or historical
OSM references are coalesced before per-id merge, with incoming edges rewritten to the retained
`PlaceId`. It never silently discards a conflicting note body.

Schema migrations obey the same graph invariants. When the standalone save model is upgraded to
membership-is-existence, every formerly saved place must either retain an existing list membership
or be placed in an explicit migration-created list; it may never become a hidden live orphan.

Editor bearer tokens are excluded, and there is no recovery bundle: a page can only be updated from
the device that published it, and the app says so. A separate explicitly encrypted recovery bundle may
include them; exporting a list, a post, or ordinary JSON must never leak write access to public pages.

## Publication while offline

The [share service](./sharing.md#share-service) is independent of sync. A list or post edit
updates local state, increments `Publication.localRevision`, and adds an idempotent outbox job in
the same transaction.

Every outbox job is immutable and includes the projected local revision, content hash, idempotency
key, and expected server ETag. The publisher moves an attempt through
`queued → publishing → published` or `failed`. A successful older attempt updates only its own job;
it cannot set `lastPublishedLocalRevision` past, or clear, a newer queued edit. The UI states
“changes pending” whenever `localRevision !== lastPublishedLocalRevision`. Revocation uses the same
durable mechanism and an idempotent delete job.

## Multi-device sync

**Multi-device sync is in v1.** The initial version is
local storage **with remote sync**: a personal library that exists on one browser's IndexedDB
only is too fragile to be the system of record for years of curation and writing. Sync stays
exactly what the architecture always reserved room for — a background transport draining the
mutation outbox — and does not change local read/write semantics. An account exists **only**
to name the sync scope; solo, account-free use remains fully supported.

- Every mutation has a globally unique id, actor id, entity id, and deterministic revision stamp
  such as a hybrid logical clock. Client `updatedAt` is display metadata, not the conflict order.
- Push is idempotent; pull uses a server-monotonic cursor.
- Tombstones remain until all active devices have acknowledged them or a documented retention
  horizon expires.
- Tag assignments, list blocks, post blocks, and note attachments sync as independent edge
  entities, so concurrent changes do not replace an entire list or post array.
- Concurrent Markdown edits preserve both bodies and create a recoverable conflict copy rather
  than silently applying last-writer-wins.
- Bottom-up teardown prerequisites are checked on the device that deletes, but sync can still
  interleave a removal with a concurrent remote note edit; the raced note surfaces as a
  recoverable conflict copy for the owner to rescue, never a silent drop.
- Relinking a `Place` merges append-only OSM history conservatively. Conflicting candidate choices
  become `needs-review`.

CRDTs are unnecessary for the single-owner workflow. They remain an option for true collaborative
editing, but are not a substitute for explicit identity and publication semantics.

## Data ownership summary

| Data | Location | Update mechanism |
|---|---|---|
| Place identity and OSM evidence | IndexedDB; included in backup | Exact resolve and conservative relink |
| List membership, tags, notes, lists, posts | IndexedDB | Local edits; background multi-device sync |
| Media bytes | IndexedDB media store | Local import; explicit hosted upload |
| Publication editor token | Private local credential store | Created once; device-held, never synced |
| Hosted public list/post/note | Share-service storage | Last successful Bearer-authorized publish |
| OSM source facts | OSM-derived production resolver | TTL refresh; user edits occur upstream in OSM |
