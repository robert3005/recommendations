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
- `savedPlaces`, `notes`, `tags`, `tagAssignments`, `lists`, `listBlocks`,
  `blockNoteAttachments`, and `blockTagSelections` — personal domain entities.
- `media` — binary image blobs keyed separately from portable `MediaAsset` metadata.
- `publications` — private publication state, public slug, revisions, status, and a reference to a
  local credential.
- `credentials` — hosted-share editor bearer tokens; never included in public documents.
- `mutationOutbox` — durable local mutation ids for future sync.
- `publicationOutbox` — idempotent publish and revoke jobs.

There is no separate authoritative `poiCache`: `Place.lastVerified` is the durable display fallback
and identity evidence. A short-lived resolver response cache may exist for performance, but it is
rebuildable and cannot replace `Place` state.

Useful indexes include current and historical OSM reference, resolution state, `updatedAt`,
`savedPlace.placeId`, tag-assignment pairs, list-block `(listId, rank)`, place blocks by
`savedPlaceId`, and publication status. Ordered edges sort by `(rank, id)` and rebalance ranks
deterministically. Repository transactions enforce uniqueness and update dependent edges atomically.

## Repository and effect boundaries

The domain reads and writes a local repository. Network synchronization and publication are
separate effects rather than alternate repositories with different latency and failure semantics.

```ts
interface LocalRepository {
  transaction<T>(work: (tx: LocalTransaction) => Promise<T>): Promise<T>;

  getPlace(id: PlaceId): Promise<Place | undefined>;
  findPlaceByOsmRef(ref: OsmElementRef): Promise<Place | undefined>;
  upsertPlace(place: Place): Promise<void>;

  listSavedPlaces(): Promise<SavedPlace[]>;
  upsertSavedPlace(saved: SavedPlace): Promise<void>;

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

Creating a place and saving it, deleting a list and its owned section blocks, or changing a guide
and queuing its publication are aggregate transactions. A failed network effect never rolls back a
committed local edit.

## Offline behavior

The app shell is cached from the first release so an already-opened installation can launch
offline. The UI exposes capability rather than using a blanket “offline capable” claim.

| Capability | Offline behavior |
|---|---|
| View/edit saved places, tags, notes, and guides | Works from IndexedDB |
| View saved POI facts | Uses timestamped `lastVerified` evidence |
| View previously cached map area | Best effort, subject to tile-provider policy/cache |
| Search or browse live POIs | Unavailable |
| Refresh or repair an OSM link | Queued until online |
| Create an OSM-backed saved place | Requires a resolved OSM candidate |
| Create an unlinked manual pin | Works fully offline |
| Publish, revoke, or upload media | Local change queues; public revision remains unchanged |

IndexedDB may be evicted or cleared. The app requests persistent storage where supported, surfaces
quota failures, explains device-local durability, and periodically prompts users to create a
backup. It never bulk-prefetches map tiles unless the selected provider explicitly permits it.

## OSM freshness and identity repair

> **Deferred for now (2026-07-18):** the freshness UI (TTL refresh, Check for OSM updates,
> stale/review states) is out of the v1 surface — see [The Map View](./map-view.md). The rules
> below describe the design of record for when it returns.

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
├── manifest.json             # schema version, checksums, export metadata
├── data.json                 # owned entities + bounded attributed OSM identity evidence
└── media/<asset-id>.<ext>    # optional binary media
```

OSM-derived evidence is included because it is necessary to preserve place identity and offline
fallback. The manifest labels its source, observation timestamp, attribution, and license. Ephemeral
resolver caches are excluded.

Imports validate schema, checksums, coordinates, ids, and size limits before a transaction begins.
The user chooses merge or replace. Merge uses the place-deduplication order from
[Durable Place Identity](./place-identity.md#import-and-deduplication) and never silently discards a
conflicting note body.

Editor bearer tokens are excluded by default. A separate explicitly encrypted recovery bundle may
include them; exporting a guide or ordinary JSON must never leak write access to public pages.

## Publication while offline

The [share service](./sharing.md#share-service) is independent of sync. A guide edit updates local
state, increments `Publication.localRevision`, and adds an idempotent outbox job in the same
transaction.

Every outbox job is immutable and includes the projected local revision, content hash, idempotency
key, and expected server ETag. The publisher moves an attempt through
`queued → publishing → published` or `failed`. A successful older attempt updates only its own job;
it cannot set `lastPublishedLocalRevision` past, or clear, a newer queued edit. The UI states
“changes pending” whenever `localRevision !== lastPublishedLocalRevision`. Revocation uses the same
durable mechanism and an idempotent delete job.

## Optional multi-device sync

Sync can be added later without changing local read/write semantics:

- Every mutation has a globally unique id, actor id, entity id, and deterministic revision stamp
  such as a hybrid logical clock. Client `updatedAt` is display metadata, not the conflict order.
- Push is idempotent; pull uses a server-monotonic cursor.
- Tombstones remain until all active devices have acknowledged them or a documented retention
  horizon expires.
- Tag assignments, list blocks, and note attachments sync as independent edge entities, so
  concurrent changes do not replace an entire list array.
- Concurrent Markdown edits preserve both bodies and create a recoverable conflict copy rather
  than silently applying last-writer-wins.
- Relinking a `Place` merges append-only OSM history conservatively. Conflicting candidate choices
  become `needs-review`.

CRDTs are unnecessary for the initial single-owner workflow. They remain an option for true
collaborative editing, but are not a substitute for explicit identity and publication semantics.

## Data ownership summary

| Data | Location | Update mechanism |
|---|---|---|
| Place identity and OSM evidence | IndexedDB; included in backup | Exact resolve and conservative relink |
| Saves, tags, notes, guides | IndexedDB | Local edits; optional future sync |
| Media bytes | IndexedDB media store | Local import; explicit hosted upload |
| Publication editor token | Private local credential store | Created once; optional encrypted recovery |
| Hosted public guide/note | Share-service storage | Last successful Bearer-authorized publish |
| OSM source facts | OSM-derived production resolver | TTL refresh; user edits occur upstream in OSM |
