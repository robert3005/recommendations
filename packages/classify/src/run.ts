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
 * review text, prompt version or model).
 */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPlaceProfile,
  type PlaceProfile,
  type ReviewAnalysis,
  type ReviewInput,
  reviewsNeedingAnalysis,
} from "@placemarks/domain";
import { harvestReviewSchema, placeSnapshotSchema } from "@placemarks/schemas";
import { ClassifierError, type ReviewClassifier } from "./classifiers/types";
import { PROMPT_VERSION } from "./prompt";
import { toAnalysis, toSummary } from "./schema";

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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ClassifierError && err.retryable) || i >= attempts) throw err;
      await sleep(1000 * 2 ** i);
    }
  }
}

export interface AnalyseOptions {
  now?: () => string;
  summarise?: boolean;
  /** Also write profile.json (the one the app loads). Off for comparison runs. */
  writeDefaultProfile?: boolean;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface AnalyseResult {
  sourcePlaceKey: string;
  analysed: number;
  skipped: number;
  failed: number;
  profile: PlaceProfile;
}

export async function analysePlace(
  folder: PlaceFolder,
  classifier: ReviewClassifier,
  opts: AnalyseOptions = {},
): Promise<AnalyseResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const log = opts.log ?? (() => {});
  const analysesPath = join(folder.dir, `analyses.${classifierSlug(classifier.id)}.jsonl`);
  const existing = await readJsonl<ReviewAnalysis>(analysesPath);
  const todo = reviewsNeedingAnalysis(folder.reviews, existing, classifier.id, PROMPT_VERSION);
  const byId = new Map(folder.reviews.map((r) => [r.id, r]));

  const fresh: ReviewAnalysis[] = [];
  let failed = 0;
  for (const part of chunk(todo, classifier.chunkSize)) {
    try {
      const out = await withRetry(
        () => classifier.classify(part, { placeName: folder.name }),
        3,
        opts.sleep,
      );
      const wanted = new Set(part.map((r) => r.id));
      const analysedAt = now();
      for (const x of out) {
        const review = byId.get(x.id);
        if (!review || !wanted.has(x.id)) continue;
        wanted.delete(x.id);
        fresh.push(
          toAnalysis(x, review, {
            sourcePlaceKey: folder.sourcePlaceKey,
            classifier: classifier.id,
            promptVersion: PROMPT_VERSION,
            analysedAt,
          }),
        );
      }
      if (wanted.size > 0) {
        failed += wanted.size;
        log(`  ${wanted.size} review(s) missing from the response; they will be retried next run`);
      }
    } catch (err) {
      failed += part.length;
      log(`  chunk of ${part.length} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Latest analysis per review wins; analyses of reviews that disappeared are dropped.
  const merged = new Map<string, ReviewAnalysis>();
  for (const a of [...existing, ...fresh]) if (byId.has(a.reviewId)) merged.set(a.reviewId, a);
  const analyses = [...merged.values()];
  if (fresh.length > 0 || analyses.length !== existing.length) {
    await writeAtomic(
      analysesPath,
      analyses.map((a) => JSON.stringify(a)).join("\n") + (analyses.length ? "\n" : ""),
    );
  }

  const profile = buildPlaceProfile(
    folder.sourcePlaceKey,
    folder.reviews,
    analyses.filter((a) => a.promptVersion === PROMPT_VERSION),
    now(),
  );

  const perClassifierPath = join(folder.dir, `profile.${classifierSlug(classifier.id)}.json`);
  // Nothing analysed (every call failed, or no review text): leave existing profiles alone.
  if (analyses.length === 0) {
    return {
      sourcePlaceKey: folder.sourcePlaceKey,
      analysed: 0,
      skipped: folder.reviews.length - todo.length,
      failed,
      profile,
    };
  }
  const previous = await readJson<PlaceProfile>(perClassifierPath);
  const summarise = classifier.summarise?.bind(classifier);
  if (opts.summarise !== false && summarise && profile.usefulCount > 0) {
    if (fresh.length === 0 && previous?.summary && previous.usefulCount === profile.usefulCount) {
      profile.summary = previous.summary;
    } else {
      try {
        const evidence = summaryEvidence(analyses);
        const out = await withRetry(
          () => summarise(profile, evidence, { placeName: folder.name }),
          3,
          opts.sleep,
        );
        profile.summary = toSummary(out, new Set(byId.keys()), classifier.id, now());
      } catch (err) {
        log(`  summary failed: ${err instanceof Error ? err.message : String(err)}`);
        if (previous?.summary) profile.summary = previous.summary;
      }
    }
  } else if (previous?.summary) {
    // Summaries off (e.g. a compare run): keep the one already written.
    profile.summary = previous.summary;
  }

  const json = `${JSON.stringify(profile, null, 2)}\n`;
  await writeAtomic(perClassifierPath, json);
  if (opts.writeDefaultProfile !== false) await writeAtomic(join(folder.dir, "profile.json"), json);

  return {
    sourcePlaceKey: folder.sourcePlaceKey,
    analysed: fresh.length,
    skipped: folder.reviews.length - todo.length,
    failed,
    profile,
  };
}

/** Short verbatim phrases the summary may lean on, at most 40, spread across reviews. */
export function summaryEvidence(
  analyses: ReviewAnalysis[],
): { reviewId: string; kind: string; quote: string }[] {
  const out: { reviewId: string; kind: string; quote: string }[] = [];
  for (const a of analyses) {
    if (!a.useful) continue;
    const items = [
      ...a.aspects.map((x) => ({ kind: x.aspect, quote: x.quote })),
      ...a.dishes.map((x) => ({ kind: `dish:${x.name}`, quote: x.quote })),
      ...a.redFlags.map((x) => ({ kind: `flag:${x.flag}`, quote: x.quote })),
    ];
    for (const it of items.slice(0, 3))
      if (it.quote) out.push({ reviewId: a.reviewId, kind: it.kind, quote: it.quote });
    if (out.length >= 40) break;
  }
  return out.slice(0, 40);
}
