/**
 * The harvest dataset contract (spec/src/harvest.md): what the local harvester
 * writes to disk, what the web app imports, and what the review classifier
 * reads. One shape for all three, validated with these schemas.
 *
 * Layout under the data directory (default ~/placemarks-data):
 *
 *   manifest.json                       HarvestManifest
 *   places/<dir>/place.json             PlaceSnapshot (latest)
 *   places/<dir>/reviews.jsonl          one HarvestReview per line
 *   places/<dir>/photos.jsonl           one HarvestPhoto per line
 *
 * `<dir>` is `placeDirName(sourcePlaceKey)` — the key with `:` replaced, so it
 * is a legal file name everywhere.
 */
import { z } from "zod";

export const HARVEST_SCHEMA_VERSION = 1;

/**
 * Google's listing id: the `0x…:0x…` feature id (what the Takeout importer
 * parses from `googleUrl`), or `cid:<digits>` when only the CID is known.
 * Lowercase. This is the join key on disk.
 */
export const sourcePlaceKeySchema = z
  .string()
  .regex(/^(0x[0-9a-f]+:0x[0-9a-f]+|cid:\d+)$/, "Google feature id or cid:<digits>");

export const harvestProviderSchema = z.enum(["gosom", "apify", "serpapi", "takeout"]);
export type HarvestProvider = z.infer<typeof harvestProviderSchema>;

const isoDate = z.string().datetime({ offset: true });
const rating = z.number().min(1).max(5);

export const placeSnapshotSchema = z.object({
  sourcePlaceKey: sourcePlaceKeySchema,
  googlePlaceId: z.string().optional(), // "ChIJ…"
  cid: z.string().regex(/^\d+$/).optional(),
  googleUrl: z.string().url().optional(),
  name: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  ratingCount: z.number().int().nonnegative().optional(),
  /** Count of reviews per star, when the provider has it. */
  ratingHistogram: z.partialRecord(z.enum(["1", "2", "3", "4", "5"]), z.number().int()).optional(),
  priceLevel: z.number().int().min(1).max(4).optional(),
  /** The provider's raw price text ("$$", "€10–20"), kept when it isn't a plain level. */
  priceText: z.string().optional(),
  types: z.array(z.string()),
  website: z.string().optional(),
  phone: z.string().optional(),
  openingHours: z.array(z.string()).optional(), // "Monday: 9 AM–5 PM"
  description: z.string().optional(),
  /** Open/closed state when the provider reports one ("Permanently closed"). */
  businessStatus: z.string().optional(),
  /** Google's one-line editorial blurb ("Iconic Jewish deli for classic eats"). */
  editorialSummary: z.string().optional(),
  timezone: z.string().optional(),
  /** How complete the review download was (see HarvestReviewCollection). */
  reviewCollection: z
    .object({
      status: z.enum(["complete", "limited", "partial", "unknown"]),
      collected: z.number().int().nonnegative(),
      expected: z.number().int().nonnegative().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  provider: harvestProviderSchema,
  fetchedAt: isoDate,
});
export type PlaceSnapshot = z.infer<typeof placeSnapshotSchema>;

export const harvestReviewSchema = z.object({
  /** Deterministic: the same source review always gets the same id. */
  id: z.string().min(1),
  /** App PlaceId — absent on disk; set once the place is in the library. */
  placeId: z.string().optional(),
  sourcePlaceKey: sourcePlaceKeySchema,
  source: z.literal("google"),
  sourceReviewId: z.string().min(1),
  authorName: z.string().optional(),
  authorUrl: z.string().optional(),
  rating: rating.optional(),
  /** Original-language text; may be empty for rating-only reviews. */
  text: z.string(),
  originalLanguage: z.string().optional(),
  translatedText: z.string().optional(),
  translatedLanguage: z.string().optional(),
  ownerResponse: z.object({ text: z.string(), publishedAt: isoDate.optional() }).optional(),
  likes: z.number().int().nonnegative().optional(),
  publishedAt: isoDate.optional(),
  updatedAt: isoDate.optional(),
  relativeTime: z.string().optional(), // "3 months ago", as shown
  photos: z.array(z.string()).optional(), // HarvestPhoto ids
  provider: harvestProviderSchema,
  fetchedAt: isoDate,
  /** sha256 of rating + text + owner response; a change means the review was edited. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HarvestReview = z.infer<typeof harvestReviewSchema>;

export const harvestPhotoSchema = z
  .object({
    id: z.string().min(1),
    placeId: z.string().optional(),
    sourcePlaceKey: sourcePlaceKeySchema,
    /** The review this photo was attached to, if any. */
    reviewId: z.string().optional(),
    url: z.string().url().optional(),
    localPath: z.string().optional(), // relative to the place directory
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    caption: z.string().optional(),
    /** Required for display: who took it, with a link where known. */
    attribution: z.object({ name: z.string().min(1), url: z.string().optional() }),
    source: z.literal("google"),
    provider: harvestProviderSchema,
    fetchedAt: isoDate,
  })
  .refine((p) => p.url || p.localPath, "a photo needs a url or a localPath");
export type HarvestPhoto = z.infer<typeof harvestPhotoSchema>;

/** One input line of a run and what became of it — the run report's rows. */
export const harvestRunItemSchema = z.object({
  input: z.string(), // a URL or a search query
  /** The Takeout list (CSV file name) or other grouping this input came from. */
  list: z.string().optional(),
  title: z.string().optional(),
  status: z.enum(["fetched", "skipped-fresh", "failed", "not-found"]),
  sourcePlaceKeys: z.array(sourcePlaceKeySchema),
  reviewsAdded: z.number().int().nonnegative(),
  reviewsUpdated: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type HarvestRunItem = z.infer<typeof harvestRunItemSchema>;

export const harvestRunSchema = z.object({
  id: z.string(),
  provider: harvestProviderSchema,
  kind: z.enum(["takeout", "search", "urls", "refresh"]),
  startedAt: isoDate,
  finishedAt: isoDate.optional(),
  items: z.array(harvestRunItemSchema),
});
export type HarvestRun = z.infer<typeof harvestRunSchema>;

export const harvestManifestSchema = z.object({
  schemaVersion: z.literal(HARVEST_SCHEMA_VERSION),
  createdAt: isoDate,
  runs: z.array(harvestRunSchema),
});
export type HarvestManifest = z.infer<typeof harvestManifestSchema>;

/** `0x1:0x2` → `0x1_0x2`; `cid:123` → `cid_123`. */
export function placeDirName(sourcePlaceKey: string): string {
  return sourcePlaceKey.replace(":", "_");
}
