/**
 * Dexie schema — the durable primary store (spec/src/storage.md): one object
 * store per entity plus a key-value store for small UI state. Rows carry
 * derived index fields (googleFeatureId, osmKey, targetKey) next to the domain
 * shape; the repository derives and strips them at the boundary.
 *
 * Version 2 was a development flush; from version 3 on, upgrades are
 * additive and keep existing rows. Rows are hard-deleted — the only tombstone concept is a
 * revoked Publication row (revokedAt set).
 */
import type {
  ImportBatch,
  ImportItem,
  List,
  ListEntry,
  Place,
  Post,
  Publication,
  SavedView,
} from "@placemarks/domain";
import { upgradePlaceStars, upgradeViewStars } from "@placemarks/domain";
import Dexie, { type EntityTable } from "dexie";

/** googleFeatureId parses from googleUrl, osmKey from osmRef — the dedup indexes. */
export type PlaceRow = Place & { googleFeatureId?: string; osmKey?: string };
export type ListRow = List;
export type ListEntryRow = ListEntry;
/** targetKey via postTargetKey — how a target's posts are found without a scan. */
export type PostRow = Post & { targetKey: string };
/** targetKey via publicationTargetKey. editorToken lives ON the row (spec/src/sharing.md). */
export type PublicationRow = Publication & { targetKey: string };
export type SavedViewRow = SavedView;
export type ImportBatchRow = ImportBatch;
export type ImportItemRow = ImportItem;

/**
 * A deleted row's marker (spec/src/sync.md §Deletions): rows are hard-deleted
 * locally, but another device has to hear about it, so every deletion of a
 * synced row leaves one of these. `key` is "<table>:<id>".
 */
export interface TombstoneRow {
  key: string;
  table: string;
  id: string;
  deletedAt: string;
}

/**
 * What this device last exchanged with the sync service for a row, as
 * "u:<updatedAt>" or "d:<deletedAt>". A row whose current stamp differs is
 * waiting to be sent. Device-local bookkeeping; never synced or archived.
 */
export interface SyncStateRow {
  key: string;
  stamp: string;
}

/** Small key-value data: home map toggles, the last viewport, reminders. */
export interface SettingRow {
  key: string;
  value: unknown;
}

export class PlacemarksDb extends Dexie {
  places!: EntityTable<PlaceRow, "id">;
  lists!: EntityTable<ListRow, "id">;
  listEntries!: EntityTable<ListEntryRow, "id">;
  posts!: EntityTable<PostRow, "id">;
  publications!: EntityTable<PublicationRow, "id">;
  views!: EntityTable<SavedViewRow, "id">;
  tombstones!: EntityTable<TombstoneRow, "key">;
  syncState!: EntityTable<SyncStateRow, "key">;
  importBatches!: EntityTable<ImportBatchRow, "id">;
  importItems!: EntityTable<ImportItemRow, "id">;
  settings!: EntityTable<SettingRow, "key">;

  constructor(name = "placemarks") {
    super(name);
    const stores = {
      places: "id, updatedAt, googleFeatureId, osmKey",
      lists: "id, sourceKey",
      listEntries: "id, listId, placeId, [listId+placeId]",
      posts: "id, targetKey, updatedAt",
      publications: "id, targetKey, slug",
      importBatches: "id, status",
      importItems: "id, batchId, status",
      settings: "key",
    };
    // Version 2 is a flush of pre-refocus DEV databases, not a migration:
    // nothing has shipped (spec/src/storage.md — one schema version until it
    // does), but a developer machine can hold a database from the old build
    // whose rows crash the new model (a list without marker.shape took the
    // home page down). Upgrading clears every declared table; stores only the
    // old build knew are left behind inert. A fresh install creates version 2
    // directly and never runs this.
    this.version(2)
      .stores(stores)
      .upgrade(async (tx) => {
        for (const table of Object.keys(stores)) {
          await tx.table(table).clear();
        }
      });
    // Version 3 adds saved views (spec/src/data-model.md §Saved views). It is
    // additive — a new store, nothing rewritten — so existing libraries keep
    // every row. Places gained optional personal fields at the same time;
    // optional fields need no migration.
    this.version(3).stores({ ...stores, views: "id" });
    // Version 4 adds the two stores sync needs (spec/src/sync.md): deletion
    // markers and per-row exchange state. Additive again.
    this.version(4).stores({ ...stores, views: "id", tombstones: "key", syncState: "key" });
    // Version 5 moves the personal rating to five stars in half steps
    // (spec/src/data-model.md §The personal layer): the three-step `rating`
    // becomes `stars` (good 3 · great 4 · favourite 5) and a saved view's
    // `minRating` becomes `minStars`. Rows keep their updatedAt — the change
    // is the same on every device, so nothing needs to sync because of it.
    this.version(5)
      .stores({ ...stores, views: "id", tombstones: "key", syncState: "key" })
      .upgrade(async (tx) => {
        await tx
          .table<PlaceRow, string>("places")
          .toCollection()
          .modify((row, ref) => {
            const next = upgradePlaceStars(row);
            if (next !== row) ref.value = next;
          });
        await tx
          .table<SavedViewRow, string>("views")
          .toCollection()
          .modify((row, ref) => {
            const next = upgradeViewStars(row);
            if (next !== row) ref.value = next;
          });
      });
  }
}
