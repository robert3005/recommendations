/**
 * Classify one place's reviews and build its profile, with no file system:
 * the local `classify run` command and the hosted insights service both call
 * this. Only reviews whose analysis is missing or stale (changed review text,
 * prompt version or model) are sent to the classifier.
 */
import {
  buildPlaceProfile,
  type PlaceProfile,
  type ReviewAnalysis,
  type ReviewInput,
  reviewsNeedingAnalysis,
} from "@placemarks/domain";
import { ClassifierError, type ReviewClassifier } from "./classifiers/types";
import { PROMPT_VERSION } from "./prompt";
import { toAnalysis, toSummary } from "./schema";

export interface PlaceReviews {
  sourcePlaceKey: string;
  name?: string;
  reviews: ReviewInput[];
  /** Analyses from earlier runs; fresh ones replace them review by review. */
  existing?: ReviewAnalysis[];
  /** The profile an earlier run wrote, whose summary is reused when nothing changed. */
  previous?: PlaceProfile;
}

export interface ClassifyOptions {
  now?: () => string;
  summarise?: boolean;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClassifyResult {
  /** Every current analysis: kept from `existing` plus fresh ones. */
  analyses: ReviewAnalysis[];
  fresh: ReviewAnalysis[];
  skipped: number;
  noText: number;
  failed: number;
  profile: PlaceProfile;
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

export async function classifyPlace(
  place: PlaceReviews,
  classifier: ReviewClassifier,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const log = opts.log ?? (() => {});
  const existing = place.existing ?? [];
  const previous = place.previous;
  const todo = reviewsNeedingAnalysis(place.reviews, existing, classifier.id, PROMPT_VERSION);
  const byId = new Map(place.reviews.map((r) => [r.id, r]));
  const noText = place.reviews.filter((r) => r.text.trim() === "").length;
  const skipped = place.reviews.length - noText - todo.length;

  const fresh: ReviewAnalysis[] = [];
  let failed = 0;
  for (const part of chunk(todo, classifier.chunkSize)) {
    try {
      const out = await withRetry(
        () => classifier.classify(part, { placeName: place.name }),
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
            sourcePlaceKey: place.sourcePlaceKey,
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

  const profile = buildPlaceProfile(
    place.sourcePlaceKey,
    place.reviews,
    analyses.filter((a) => a.promptVersion === PROMPT_VERSION),
    now(),
  );
  const result = { analyses, fresh, skipped, noText, failed, profile };
  if (analyses.length === 0) return result;

  const summarise = classifier.summarise?.bind(classifier);
  if (opts.summarise !== false && summarise && profile.usefulCount > 0) {
    if (fresh.length === 0 && previous?.summary && previous.usefulCount === profile.usefulCount) {
      profile.summary = previous.summary;
    } else {
      try {
        const evidence = summaryEvidence(analyses);
        const out = await withRetry(
          () => summarise(profile, evidence, { placeName: place.name }),
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
  return result;
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
