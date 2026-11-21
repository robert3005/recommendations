/**
 * The review-insights store (spec/src/reviews.md): a second IndexedDB
 * database, separate from the library. It holds third-party data and what was
 * learned from it — place snapshots, photos, and per-place profiles — loaded
 * from the folder the local classify command writes. It is kept out of the
 * library so the archive, the repository invariants and publishing never
 * touch it. Review text is never loaded into the browser.
 */
import type { PlaceProfile } from "@placemarks/domain";
import Dexie, { type EntityTable } from "dexie";

/** place.json, reduced to what the card shows. */
export interface PlaceSourceRow {
  sourcePlaceKey: string;
  /** Set when the data is attached to a library place directly (sample data). */
  placeId?: string;
  name?: string;
  rating?: number;
  ratingCount?: number;
  priceLevel?: number;
  loadedAt: string;
}

export interface PhotoRow {
  id: string;
  sourcePlaceKey: string;
  /** Remote URL, or empty when the photo was loaded as a local file. */
  url: string;
  blob?: Blob;
  width?: number;
  height?: number;
  attribution: { name: string; url?: string };
  source: string;
}

export type ProfileRow = PlaceProfile;

export class InsightsDb extends Dexie {
  placeSources!: EntityTable<PlaceSourceRow, "sourcePlaceKey">;
  photos!: EntityTable<PhotoRow, "id">;
  placeProfiles!: EntityTable<ProfileRow, "sourcePlaceKey">;

  constructor(name = "placemarks-reviews") {
    super(name);
    this.version(1).stores({
      placeSources: "sourcePlaceKey, placeId",
      photos: "id, sourcePlaceKey",
      placeProfiles: "sourcePlaceKey",
    });
  }
}

let defaultDb: InsightsDb | undefined;
export function insightsDb(): InsightsDb {
  defaultDb ??= new InsightsDb();
  return defaultDb;
}

/** Test seam: swap the database (fake-indexeddb in unit tests). */
export function setInsightsDb(db: InsightsDb): void {
  defaultDb = db;
}
