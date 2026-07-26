/**
 * Dexie schema — the durable primary store (spec/src/storage.md): one object
 * store per entity plus a key-value store for small UI state. Rows carry
 * derived index fields (googleFeatureId, osmKey, targetKey) next to the domain
 * shape; the repository derives and strips them at the boundary.
 *
 * One schema version until something ships; migrations begin when real
 * libraries exist. Rows are hard-deleted — the only tombstone concept is a
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
} from "@placemarks/domain";
import Dexie, { type EntityTable } from "dexie";

/** googleFeatureId parses from googleUrl, osmKey from osmRef — the dedup indexes. */
export type PlaceRow = Place & { googleFeatureId?: string; osmKey?: string };
export type ListRow = List;
export type ListEntryRow = ListEntry;
/** targetKey via postTargetKey — how a target's posts are found without a scan. */
export type PostRow = Post & { targetKey: string };
/** targetKey via publicationTargetKey. editorToken lives ON the row (spec/src/sharing.md). */
export type PublicationRow = Publication & { targetKey: string };
export type ImportBatchRow = ImportBatch;
export type ImportItemRow = ImportItem;

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
  }
}
