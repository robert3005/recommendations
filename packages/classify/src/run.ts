/**
 * The on-disk pipeline. The Google import writes one folder per place:
 *
 *   <data>/places/<placeDirName(sourcePlaceKey)>/
 *     place.json         snapshot (carries the real sourcePlaceKey)
 *     reviews.jsonl      harvested reviews — classification input only
 *     photos.jsonl       harvested photos
 *
 * This module adds, in the same folder:
 *
 *   analyses.<classifier>.jsonl   one ReviewAnalysis per line
 *   profile.json                  the PlaceProfile the app shows
 *   profile.<classifier>.json     the same, per classifier (for comparisons)
 *
 * Re-runs only send reviews whose analysis is missing or stale (changed
 * review text, prompt version or model). The classification itself lives in
 * pipeline.ts, which touches no file system so the hosted service can run it.
 */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlaceProfile, ReviewAnalysis, ReviewInput } from "@placemarks/domain";
import { harvestReviewSchema, placeSnapshotSchema } from "@placemarks/schemas";
import type { ReviewClassifier } from "./classifiers/types";
import { type ClassifyOptions, classifyPlace } from "./pipeline";

export interface PlaceFolder {
  dir: string;
  sourcePlaceKey: string;
  name?: string;
  reviews: ReviewInput[];
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write via a temp file so a crash never leaves a half-written file. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export function classifierSlug(classifierId: string): string {
  return classifierId.replace(/[^a-z0-9.-]+/gi, "_");
}

/**
 * Read one place folder. Rows that fail the harvest schema are skipped (and
 * counted), so one malformed line never blocks a place. The key comes from
 * the files, never from the folder name.
 */
export async function loadPlaceFolder(
  dir: string,
  log: (msg: string) => void = () => {},
): Promise<PlaceFolder | undefined> {
  const rawPlace = await readJson<unknown>(join(dir, "place.json"));
  const place = rawPlace === undefined ? undefined : placeSnapshotSchema.safeParse(rawPlace);
  if (place && !place.success)
    log(`  ${dir}: place.json does not match the harvest schema; using reviews only`);
  const rows = await readJsonl<unknown>(join(dir, "reviews.jsonl"));
  const reviews: ReviewInput[] = [];
  let invalid = 0;
  let sourcePlaceKey = place?.success ? place.data.sourcePlaceKey : undefined;
  for (const row of rows) {
    const parsed = harvestReviewSchema.safeParse(row);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const r = parsed.data;
    sourcePlaceKey ??= r.sourcePlaceKey;
    if (r.sourcePlaceKey !== sourcePlaceKey) {
      invalid++;
      continue;
    }
    reviews.push({
      id: r.id,
      text: r.text,
      rating: r.rating,
      publishedAt: r.publishedAt,
      contentHash: r.contentHash,
    });
  }
  if (invalid > 0)
    log(`  ${dir}: skipped ${invalid} review row(s) that do not match the harvest schema`);
  if (!sourcePlaceKey) return undefined;
  return { dir, sourcePlaceKey, name: place?.success ? place.data.name : undefined, reviews };
}

export async function listPlaceDirs(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "places");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .sort();
}

export interface AnalyseOptions extends ClassifyOptions {
  /** Also write profile.json (the one the app loads). Off for comparison runs. */
  writeDefaultProfile?: boolean;
}

export interface AnalyseResult {
  sourcePlaceKey: string;
  analysed: number;
  skipped: number;
  /** Rating-only reviews: nothing to classify. */
  noText: number;
  failed: number;
  profile: PlaceProfile;
}

export async function analysePlace(
  folder: PlaceFolder,
  classifier: ReviewClassifier,
  opts: AnalyseOptions = {},
): Promise<AnalyseResult> {
  const analysesPath = join(folder.dir, `analyses.${classifierSlug(classifier.id)}.jsonl`);
  const perClassifierPath = join(folder.dir, `profile.${classifierSlug(classifier.id)}.json`);
  const existing = await readJsonl<ReviewAnalysis>(analysesPath);
  const previous = await readJson<PlaceProfile>(perClassifierPath);

  const result = await classifyPlace({ ...folder, existing, previous }, classifier, opts);
  const { analyses, fresh, profile } = result;
  if (fresh.length > 0 || analyses.length !== existing.length) {
    await writeAtomic(
      analysesPath,
      analyses.map((a) => JSON.stringify(a)).join("\n") + (analyses.length ? "\n" : ""),
    );
  }

  // Nothing analysed (every call failed, or no review text): leave existing profiles alone.
  if (analyses.length > 0) {
    const json = `${JSON.stringify(profile, null, 2)}\n`;
    await writeAtomic(perClassifierPath, json);
    if (opts.writeDefaultProfile !== false) {
      await writeAtomic(join(folder.dir, "profile.json"), json);
    }
  }

  return {
    sourcePlaceKey: folder.sourcePlaceKey,
    analysed: fresh.length,
    skipped: result.skipped,
    noText: result.noText,
    failed: result.failed,
    profile,
  };
}

export { summaryEvidence } from "./pipeline";
