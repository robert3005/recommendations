/**
 * The on-disk harvest dataset (spec/src/harvest.md). Writes are additive:
 * a refresh adds new reviews and replaces edited ones (by contentHash), and
 * never deletes a review that has since disappeared from Google.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HARVEST_SCHEMA_VERSION,
  type HarvestManifest,
  type HarvestPhoto,
  type HarvestReview,
  type HarvestRun,
  harvestManifestSchema,
  harvestPhotoSchema,
  harvestReviewSchema,
  type PlaceSnapshot,
  placeDirName,
  placeSnapshotSchema,
} from "@placemarks/schemas";

export function defaultDataDir(): string {
  return process.env.PLACEMARKS_DATA ?? path.join(os.homedir(), "placemarks-data");
}

/** Write via a temp file and rename, so a crash never leaves half a file. */
async function writeAtomic(file: string, contents: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, contents);
  await rename(temp, file);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJsonl<T>(text: string | undefined, parse: (value: unknown) => T): T[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => parse(JSON.parse(line)));
}

const toJsonl = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

export interface MergeResult {
  reviewsAdded: number;
  reviewsUpdated: number;
}

export class HarvestStore {
  constructor(readonly dataDir: string) {}

  placeDir(sourcePlaceKey: string): string {
    return path.join(this.dataDir, "places", placeDirName(sourcePlaceKey));
  }

  async readManifest(): Promise<HarvestManifest> {
    const text = await readText(path.join(this.dataDir, "manifest.json"));
    if (!text) {
      return {
        schemaVersion: HARVEST_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        runs: [],
      };
    }
    return harvestManifestSchema.parse(JSON.parse(text));
  }

  async appendRun(run: HarvestRun): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const manifest = await this.readManifest();
    manifest.runs = [...manifest.runs.filter((r) => r.id !== run.id), run];
    await writeAtomic(
      path.join(this.dataDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  async readPlace(sourcePlaceKey: string): Promise<PlaceSnapshot | undefined> {
    const text = await readText(path.join(this.placeDir(sourcePlaceKey), "place.json"));
    return text ? placeSnapshotSchema.parse(JSON.parse(text)) : undefined;
  }

  async readReviews(sourcePlaceKey: string): Promise<HarvestReview[]> {
    const text = await readText(path.join(this.placeDir(sourcePlaceKey), "reviews.jsonl"));
    return parseJsonl(text, (v) => harvestReviewSchema.parse(v));
  }

  async readPhotos(sourcePlaceKey: string): Promise<HarvestPhoto[]> {
    const text = await readText(path.join(this.placeDir(sourcePlaceKey), "photos.jsonl"));
    return parseJsonl(text, (v) => harvestPhotoSchema.parse(v));
  }

  /** Has this place been fetched within `maxAgeDays`? Used to skip on re-runs. */
  async isFresh(sourcePlaceKey: string, maxAgeDays: number, now = Date.now()): Promise<boolean> {
    const place = await this.readPlace(sourcePlaceKey);
    if (!place) return false;
    return now - Date.parse(place.fetchedAt) < maxAgeDays * 86_400_000;
  }

  /**
   * Save a fetched place. The snapshot is replaced; reviews merge by
   * sourceReviewId (new → added, changed contentHash → updated, missing →
   * kept); photos merge by id.
   */
  async savePlace(
    place: PlaceSnapshot,
    reviews: HarvestReview[],
    photos: HarvestPhoto[],
  ): Promise<MergeResult> {
    const dir = this.placeDir(place.sourcePlaceKey);
    await mkdir(dir, { recursive: true });

    const existing = await this.readReviews(place.sourcePlaceKey);
    const byId = new Map(existing.map((r) => [r.sourceReviewId, r]));
    let reviewsAdded = 0;
    let reviewsUpdated = 0;
    for (const review of reviews) {
      const previous = byId.get(review.sourceReviewId);
      if (!previous) reviewsAdded++;
      else if (previous.contentHash !== review.contentHash) reviewsUpdated++;
      else continue; // unchanged: keep the original row and its fetchedAt
      byId.set(
        review.sourceReviewId,
        previous?.placeId ? { ...review, placeId: previous.placeId } : review,
      );
    }

    const photoById = new Map((await this.readPhotos(place.sourcePlaceKey)).map((p) => [p.id, p]));
    for (const photo of photos) if (!photoById.has(photo.id)) photoById.set(photo.id, photo);

    // The snapshot's collected count covers everything on disk, not just this fetch.
    const snapshot = placeSnapshotSchema.parse({
      ...place,
      ...(place.reviewCollection
        ? { reviewCollection: { ...place.reviewCollection, collected: byId.size } }
        : {}),
    });

    await writeAtomic(path.join(dir, "reviews.jsonl"), toJsonl([...byId.values()]));
    await writeAtomic(path.join(dir, "photos.jsonl"), toJsonl([...photoById.values()]));
    await writeAtomic(path.join(dir, "place.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    return { reviewsAdded, reviewsUpdated };
  }
}
