/**
 * Reviews, photos, and what is learned from them (spec/src/reviews.md).
 *
 * Harvested reviews and photos are third-party data written to disk by the
 * Google import; they key on `sourcePlaceKey` (the Google feature id
 * "0x…:0x…" for Google sources). A `ReviewAnalysis` is one classifier's reading of one review;
 * a `PlaceProfile` is computed from analyses in code (`buildPlaceProfile`), so
 * scores are reproducible and cheap to recompute. Pure TypeScript: no fetch,
 * no storage, no model SDKs.
 */

/**
 * The fields of a harvested review that classification and aggregation read.
 * The full on-disk shape (harvestReviewSchema) lives in @placemarks/schemas;
 * any row of it satisfies this.
 */
export interface ReviewInput {
  id: string;
  text: string;
  rating?: number;
  publishedAt?: string;
  contentHash: string;
}

// ── The classification vocabulary ────────────────────────────────────────────
// Fixed lists keep tags filterable; free text appears only in quotes and dish names.

export const ASPECTS = ["food", "service", "value", "ambience", "wait", "cleanliness"] as const;
export type Aspect = (typeof ASPECTS)[number];

export const PRICE_SIGNALS = ["cheap", "moderate", "pricey", "very_expensive"] as const;
export type PriceSignal = (typeof PRICE_SIGNALS)[number];

export const OCCASIONS = [
  "date_night",
  "family",
  "kids",
  "groups",
  "solo",
  "business",
  "quick_bite",
  "special_occasion",
  "brunch",
  "late_night",
] as const;
export type Occasion = (typeof OCCASIONS)[number];

export const DIETARY = [
  "vegetarian",
  "vegan",
  "gluten_free",
  "halal",
  "kosher",
  "dairy_free",
] as const;
export type Dietary = (typeof DIETARY)[number];

export const VIBES = [
  "cozy",
  "lively",
  "loud",
  "quiet",
  "romantic",
  "casual",
  "upscale",
  "trendy",
  "divey",
  "scenic_view",
  "outdoor_seating",
] as const;
export type Vibe = (typeof VIBES)[number];

export const RED_FLAGS = ["food_safety", "rude_staff", "overcharging", "closed_or_moved"] as const;
export type RedFlag = (typeof RED_FLAGS)[number];

/** Sentiment on a five-step scale: -2 very negative … +2 very positive. */
export type Sentiment = -2 | -1 | 0 | 1 | 2;

export interface ReviewAnalysis {
  reviewId: string;
  sourcePlaceKey: string;
  /** Which classifier produced it, e.g. "anthropic:claude-haiku-5-5" or "typesafe:jev-latest". */
  classifier: string;
  promptVersion: string;
  /** The review's contentHash at analysis time — a changed review is re-analysed. */
  contentHash: string;
  analysedAt: string;
  /** False for spam, one-word, or off-topic reviews; they stay out of aggregates. */
  useful: boolean;
  language?: string;
  sentiment: Sentiment;
  aspects: { aspect: Aspect; sentiment: Sentiment; quote?: string }[];
  dishes: { name: string; normalized: string; sentiment: Sentiment; quote?: string }[];
  price?: { signal: PriceSignal; amount?: number; currency?: string };
  occasions: Occasion[];
  dietary: { tag: Dietary; served: "well" | "poorly" }[];
  vibes: Vibe[];
  practical: { reservationAdvised?: boolean; waitMinutes?: number; cashOnly?: boolean };
  redFlags: { flag: RedFlag; quote?: string }[];
}

export interface PlaceProfile {
  sourcePlaceKey: string;
  computedAt: string;
  reviewCount: number;
  analysedCount: number;
  usefulCount: number;
  classifiers: string[];
  aspects: { aspect: Aspect; score: number; mentions: number }[];
  dishes: { name: string; mentions: number; score: number; reviewIds: string[] }[];
  price?: { signal: PriceSignal; mentions: number };
  tags: { kind: "vibe" | "occasion" | "dietary"; tag: string; mentions: number }[];
  warnings: { flag: RedFlag; mentions: number; reviewIds: string[] }[];
  practical: { reservationAdvised: number; cashOnly: number; medianWaitMinutes?: number };
  summary?: PlaceSummary;
}

export interface PlaceSummary {
  text: string;
  claims: { text: string; reviewIds: string[] }[];
  classifier: string;
  createdAt: string;
}

// ── Evidence ────────────────────────────────────────────────────────────────

function squash(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether `quote` appears verbatim in `text`, ignoring case, whitespace runs,
 * and typographic quote/dash variants. A model quote that fails this is not
 * evidence and is dropped.
 */
export function isVerbatim(quote: string, text: string): boolean {
  const q = squash(quote).replace(/^["'.…\s]+|["'.…\s]+$/g, "");
  return q.length >= 3 && squash(text).includes(q);
}

/** Locate `quote` in `text` for highlighting: [start, end) or undefined. */
export function quoteRange(quote: string, text: string): [number, number] | undefined {
  const q = quote.trim().replace(/^["'“‘]+|["'”’.…]+$/g, "");
  if (q.length < 3) return undefined;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  return idx < 0 ? undefined : [idx, idx + q.length];
}

/** Drop every quote in an analysis that is not verbatim in the review's text. */
export function keepVerbatimEvidence(analysis: ReviewAnalysis, text: string): ReviewAnalysis {
  const keep = (quote?: string) =>
    quote !== undefined && isVerbatim(quote, text) ? quote : undefined;
  return {
    ...analysis,
    aspects: analysis.aspects.map((a) => ({ ...a, quote: keep(a.quote) })),
    dishes: analysis.dishes.map((d) => ({ ...d, quote: keep(d.quote) })),
    redFlags: analysis.redFlags.map((r) => ({ ...r, quote: keep(r.quote) })),
  };
}

export function clampSentiment(n: number): Sentiment {
  const r = Math.round(Number.isFinite(n) ? n : 0);
  return Math.max(-2, Math.min(2, r)) as Sentiment;
}

/** Plural to singular for grouping only ("pickles" → "pickle", "fries" → "fry"). */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * Dish names fold together on lowercase, accents stripped, punctuation and
 * articles dropped, plurals singular. The key groups dishes; the display name
 * is the most common plain-English name the classifier gave.
 */
export function normalizeDish(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|their|our)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Recency weight: halves every year; undated reviews count fully. */
export function recencyWeight(publishedAt: string | undefined, now: string): number {
  if (!publishedAt) return 1;
  const age = (Date.parse(now) - Date.parse(publishedAt)) / DAY_MS;
  if (!Number.isFinite(age) || age <= 0) return 1;
  return 0.5 ** (age / 365);
}

export const TAG_MIN_MENTIONS = 3;
export const TAG_MIN_SHARE = 0.1;
export const WARNING_MIN_MENTIONS = 2;
export const WARNING_WINDOW_DAYS = 548; // ~18 months

function weightedMean(pairs: { value: number; weight: number }[]): number {
  const w = pairs.reduce((s, p) => s + p.weight, 0);
  if (w === 0) return 0;
  return pairs.reduce((s, p) => s + p.value * p.weight, 0) / w;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * The per-place profile, computed from the place's reviews and their analyses.
 * Only analyses whose contentHash still matches their review count; reviews
 * flagged not useful stay out of every aggregate. When a review has several
 * analyses (two classifiers), the one listed first in `analyses` wins.
 */
export function buildPlaceProfile(
  sourcePlaceKey: string,
  reviews: ReviewInput[],
  analyses: ReviewAnalysis[],
  now: string,
): PlaceProfile {
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const current = new Map<string, ReviewAnalysis>();
  for (const a of analyses) {
    const review = byId.get(a.reviewId);
    if (!review || review.contentHash !== a.contentHash || current.has(a.reviewId)) continue;
    current.set(a.reviewId, a);
  }
  const useful = [...current.values()].filter((a) => a.useful);
  const weightOf = (a: ReviewAnalysis) => recencyWeight(byId.get(a.reviewId)?.publishedAt, now);

  const aspects = ASPECTS.flatMap((aspect) => {
    const pairs = useful.flatMap((a) =>
      a.aspects
        .filter((x) => x.aspect === aspect)
        .map((x) => ({ value: x.sentiment, weight: weightOf(a) })),
    );
    return pairs.length === 0
      ? []
      : [{ aspect, score: weightedMean(pairs), mentions: pairs.length }];
  });

  interface DishGroup {
    names: Map<string, number>;
    pairs: { value: number; weight: number }[];
    reviewIds: Set<string>;
  }
  const dishGroups = new Map<string, DishGroup>();
  for (const a of useful) {
    for (const d of a.dishes) {
      const key = normalizeDish(d.normalized || d.name);
      if (!key) continue;
      const g: DishGroup = dishGroups.get(key) ?? {
        names: new Map(),
        pairs: [],
        reviewIds: new Set(),
      };
      if (!g.reviewIds.has(a.reviewId)) g.pairs.push({ value: d.sentiment, weight: weightOf(a) });
      g.reviewIds.add(a.reviewId);
      const label = (d.normalized || d.name).trim().toLowerCase();
      g.names.set(label, (g.names.get(label) ?? 0) + 1);
      dishGroups.set(key, g);
    }
  }
  const dishes = [...dishGroups.values()]
    .map((g) => ({
      // Display the most common plain-English name, so spellings and languages fold.
      name:
        [...g.names.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ??
        "",
      mentions: g.reviewIds.size,
      score: weightedMean(g.pairs),
      reviewIds: [...g.reviewIds],
    }))
    .sort((x, y) => y.mentions - x.mentions || y.score - x.score || x.name.localeCompare(y.name));

  const priceCounts = new Map<PriceSignal, number>();
  for (const a of useful)
    if (a.price) priceCounts.set(a.price.signal, (priceCounts.get(a.price.signal) ?? 0) + 1);
  const topPrice = [...priceCounts.entries()].sort(
    (x, y) => y[1] - x[1] || PRICE_SIGNALS.indexOf(x[0]) - PRICE_SIGNALS.indexOf(y[0]),
  )[0];

  const threshold = Math.max(TAG_MIN_MENTIONS, Math.ceil(useful.length * TAG_MIN_SHARE));
  const tags: PlaceProfile["tags"] = [];
  const countTags = (
    kind: "vibe" | "occasion" | "dietary",
    pick: (a: ReviewAnalysis) => string[],
    vocab: readonly string[],
  ) => {
    const counts = new Map<string, number>();
    for (const a of useful)
      for (const t of new Set(pick(a))) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const tag of vocab) {
      const mentions = counts.get(tag) ?? 0;
      if (mentions >= threshold) tags.push({ kind, tag, mentions });
    }
  };
  countTags("vibe", (a) => a.vibes, VIBES);
  countTags("occasion", (a) => a.occasions, OCCASIONS);
  countTags(
    "dietary",
    (a) => a.dietary.filter((d) => d.served === "well").map((d) => d.tag),
    DIETARY,
  );
  tags.sort((x, y) => y.mentions - x.mentions);

  const nowMs = Date.parse(now);
  const recent = (a: ReviewAnalysis) => {
    const at = byId.get(a.reviewId)?.publishedAt;
    return !at || nowMs - Date.parse(at) <= WARNING_WINDOW_DAYS * DAY_MS;
  };
  const warnings = RED_FLAGS.flatMap((flag) => {
    const ids = useful
      .filter((a) => recent(a) && a.redFlags.some((r) => r.flag === flag))
      .map((a) => a.reviewId);
    return ids.length >= WARNING_MIN_MENTIONS
      ? [{ flag, mentions: ids.length, reviewIds: ids }]
      : [];
  });

  const waits = useful.flatMap((a) =>
    a.practical.waitMinutes === undefined ? [] : [a.practical.waitMinutes],
  );

  return {
    sourcePlaceKey,
    computedAt: now,
    reviewCount: reviews.length,
    analysedCount: current.size,
    usefulCount: useful.length,
    classifiers: [...new Set([...current.values()].map((a) => a.classifier))].sort(),
    aspects,
    dishes,
    price: topPrice ? { signal: topPrice[0], mentions: topPrice[1] } : undefined,
    tags,
    warnings,
    practical: {
      reservationAdvised: useful.filter((a) => a.practical.reservationAdvised).length,
      cashOnly: useful.filter((a) => a.practical.cashOnly).length,
      medianWaitMinutes: median(waits),
    },
  };
}

/** Reviews whose analysis is missing or stale for this classifier and prompt version. */
export function reviewsNeedingAnalysis(
  reviews: ReviewInput[],
  analyses: ReviewAnalysis[],
  classifier: string,
  promptVersion: string,
): ReviewInput[] {
  const done = new Set(
    analyses
      .filter((a) => a.classifier === classifier && a.promptVersion === promptVersion)
      .map((a) => `${a.reviewId}\u0000${a.contentHash}`),
  );
  return reviews.filter(
    (r) => r.text.trim().length > 0 && !done.has(`${r.id}\u0000${r.contentHash}`),
  );
}

/** Human labels for the fixed vocabulary. */
export function vocabLabel(tag: string): string {
  const special: Record<string, string> = {
    gluten_free: "Gluten-free",
    dairy_free: "Dairy-free",
    very_expensive: "Very expensive",
    scenic_view: "Scenic view",
    outdoor_seating: "Outdoor seating",
    date_night: "Date night",
    quick_bite: "Quick bite",
    special_occasion: "Special occasion",
    late_night: "Late night",
    food_safety: "Food safety",
    rude_staff: "Rude staff",
    closed_or_moved: "Closed or moved",
    kids: "Kid-friendly",
    groups: "Groups",
  };
  return special[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1).replace(/_/g, " ");
}
