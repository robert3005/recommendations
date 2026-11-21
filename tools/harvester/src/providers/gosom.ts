/**
 * The self-hosted provider: gosom/google-maps-scraper (MIT), run locally in
 * Docker or as a binary. It drives a headless browser against Google Maps
 * anonymously; with -extra-reviews it collects whatever reviews Google shows
 * an anonymous visitor (often a few hundred; sometimes a "limited view").
 *
 * This module builds the scraper's input file and arguments, runs it, and
 * normalizes its JSON entries into the harvest dataset shape.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { googleFeatureId } from "@placemarks/domain";
import {
  type HarvestPhoto,
  type HarvestReview,
  type PlaceSnapshot,
  placeSnapshotSchema,
  sourcePlaceKeySchema,
} from "@placemarks/schemas";
import {
  isHttpUrl,
  isoFromMicros,
  nonEmpty,
  openingHoursLines,
  priceLevelFromText,
  reviewContentHash,
  stableId,
} from "../normalize";
import type {
  HarvestedPlace,
  HarvestInput,
  HarvestOptions,
  Provider,
  ProviderResult,
} from "./types";

/** Pinned so a scraper update can't silently change the output shape. */
export const DEFAULT_GOSOM_IMAGE = "gosom/google-maps-scraper:v1.19.0";

// ---------- The scraper's JSON shape (gmaps/entry.go) ----------

export interface GosomReview {
  Name?: string;
  ProfilePicture?: string;
  Rating?: number;
  Description?: string;
  Images?: string[] | null;
  When?: string;
  review_id?: string;
  rating_float?: number;
  author_url?: string;
  posted_at_unix_micros?: number;
  updated_at_unix_micros?: number;
  language?: string;
  translated_lang?: string;
  text_original?: string;
  text_translated?: string;
  reply_text?: string;
  reply_text_original?: string;
  reply_posted_at_unix_micros?: number;
  published_at?: string;
}

export interface GosomEntry {
  input_id?: string;
  link?: string;
  cid?: string;
  title?: string;
  categories?: string[] | null;
  category?: string;
  address?: string;
  open_hours?: Record<string, string[]> | null;
  web_site?: string;
  phone?: string;
  review_count?: number;
  review_rating?: number;
  reviews_per_rating?: Record<string, number> | null;
  latitude?: number;
  longitude?: number;
  longtitude?: number;
  status?: string;
  description?: string;
  timezone?: string;
  price_range?: string;
  data_id?: string;
  place_id?: string;
  images?: { title?: string; image?: string }[] | null;
  user_reviews?: GosomReview[] | null;
  user_reviews_extended?: GosomReview[] | null;
  review_collection?: {
    status?: string;
    method?: string;
    collected?: number;
    expected?: number;
    reason?: string;
  } | null;
}

// ---------- Input file and arguments ----------

/** gosom's custom-id syntax: `query #!#id` comes back as `input_id: "id"`. */
export function buildInputFile(inputs: HarvestInput[]): string {
  return `${inputs
    .map((input, index) => `${input.query.replace(/[\r\n]+/g, " ").trim()} #!#${index}`)
    .join("\n")}\n`;
}

export function buildScraperArgs(
  options: Pick<HarvestOptions, "extraReviews" | "depth" | "area" | "language">,
  paths: { input: string; results: string },
): string[] {
  const args = [
    "-input",
    paths.input,
    "-results",
    paths.results,
    "-json",
    "-depth",
    String(options.depth),
    "-lang",
    options.language,
    // One page at a time: slow and polite, and the least likely to be blocked.
    "-c",
    "1",
    "-exit-on-inactivity",
    "3m",
  ];
  if (options.extraReviews) args.push("-extra-reviews");
  const area = options.area;
  if (area?.bbox) {
    args.push("-grid-bbox", area.bbox.join(","), "-zoom", "15", "-grid-strict");
  } else if (area?.geo) {
    args.push("-geo", `${area.geo.lat},${area.geo.lng}`);
    if (area.radiusMeters) args.push("-radius", String(area.radiusMeters));
  }
  return args;
}

// ---------- Normalization ----------

export function sourcePlaceKeyOf(entry: GosomEntry): string | undefined {
  const candidates = [
    entry.data_id?.toLowerCase(),
    entry.link ? googleFeatureId(entry.link) : undefined,
    entry.cid && /^\d+$/.test(entry.cid) ? `cid:${entry.cid}` : undefined,
  ];
  return candidates.find((key) => key && sourcePlaceKeySchema.safeParse(key).success);
}

function collectionStatus(
  status: string | undefined,
): NonNullable<PlaceSnapshot["reviewCollection"]>["status"] {
  return status === "complete" || status === "limited" || status === "partial" ? status : "unknown";
}

function histogram(
  raw: Record<string, number> | null | undefined,
): PlaceSnapshot["ratingHistogram"] {
  if (!raw) return undefined;
  const out: Record<string, number> = {};
  for (const star of ["1", "2", "3", "4", "5"]) {
    const count = raw[star];
    if (typeof count === "number" && Number.isInteger(count)) out[star] = count;
  }
  return Object.keys(out).length > 0 ? (out as PlaceSnapshot["ratingHistogram"]) : undefined;
}

function normalizeReview(
  raw: GosomReview,
  sourcePlaceKey: string,
  fetchedAt: string,
): { review: HarvestReview; photos: HarvestPhoto[] } | undefined {
  const text = nonEmpty(raw.text_original) ?? nonEmpty(raw.Description) ?? "";
  const ratingValue = raw.rating_float || raw.Rating || undefined;
  const rating =
    ratingValue && ratingValue >= 1 && ratingValue <= 5 ? Math.round(ratingValue) : undefined;
  const authorName = nonEmpty(raw.Name);
  // Older scraper output has no review_id; fall back to a hash of what identifies it.
  const sourceReviewId =
    nonEmpty(raw.review_id) ??
    stableId("anon", authorName ?? "", String(rating ?? ""), text, raw.When ?? "");
  if (!text && rating === undefined) return undefined;

  const replyText = nonEmpty(raw.reply_text_original) ?? nonEmpty(raw.reply_text);
  const ownerResponse = replyText
    ? {
        text: replyText,
        ...(isoFromMicros(raw.reply_posted_at_unix_micros)
          ? { publishedAt: isoFromMicros(raw.reply_posted_at_unix_micros) }
          : {}),
      }
    : undefined;

  const id = stableId("rev", sourcePlaceKey, sourceReviewId);
  const photos: HarvestPhoto[] = (raw.Images ?? []).filter(isHttpUrl).map((url) => ({
    id: stableId("pho", sourcePlaceKey, url),
    sourcePlaceKey,
    reviewId: id,
    url,
    attribution: {
      name: authorName ?? "Google Maps user",
      ...(isHttpUrl(raw.author_url) ? { url: raw.author_url } : {}),
    },
    source: "google" as const,
    provider: "gosom" as const,
    fetchedAt,
  }));

  const translated = nonEmpty(raw.text_translated);
  const publishedAt =
    (raw.published_at && !Number.isNaN(Date.parse(raw.published_at))
      ? new Date(raw.published_at).toISOString()
      : undefined) ?? isoFromMicros(raw.posted_at_unix_micros);
  const updatedAt = isoFromMicros(raw.updated_at_unix_micros);

  const review: HarvestReview = {
    id,
    sourcePlaceKey,
    source: "google",
    sourceReviewId,
    ...(authorName ? { authorName } : {}),
    ...(isHttpUrl(raw.author_url) ? { authorUrl: raw.author_url } : {}),
    ...(rating !== undefined ? { rating } : {}),
    text,
    ...(nonEmpty(raw.language) ? { originalLanguage: nonEmpty(raw.language) } : {}),
    ...(translated && translated !== text ? { translatedText: translated } : {}),
    ...(translated && translated !== text && nonEmpty(raw.translated_lang)
      ? { translatedLanguage: nonEmpty(raw.translated_lang) }
      : {}),
    ...(ownerResponse ? { ownerResponse } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt && updatedAt !== publishedAt ? { updatedAt } : {}),
    ...(nonEmpty(raw.When) ? { relativeTime: nonEmpty(raw.When) } : {}),
    ...(photos.length > 0 ? { photos: photos.map((p) => p.id) } : {}),
    provider: "gosom",
    fetchedAt,
    contentHash: reviewContentHash({ rating, text, ownerResponse }),
  };
  return { review, photos };
}

/**
 * One scraper entry → a place, its reviews (deduped by source review id) and
 * its photos. Returns an error string instead when the entry can't be keyed or
 * placed — the run report records it, nothing is dropped silently.
 */
export function normalizeGosomEntry(
  entry: GosomEntry,
  fetchedAt: string,
): Omit<HarvestedPlace, "inputIndex"> | { error: string } {
  const sourcePlaceKey = sourcePlaceKeyOf(entry);
  if (!sourcePlaceKey) return { error: `no Google id for "${entry.title ?? entry.link ?? "?"}"` };
  const lng = entry.longitude || entry.longtitude;
  const lat = entry.latitude;
  if (!entry.title || lat === undefined || lng === undefined || (lat === 0 && lng === 0)) {
    return { error: `no name or coordinates for ${sourcePlaceKey}` };
  }

  const reviews = new Map<string, HarvestReview>();
  const photos = new Map<string, HarvestPhoto>();
  for (const raw of [...(entry.user_reviews ?? []), ...(entry.user_reviews_extended ?? [])]) {
    const normalized = normalizeReview(raw, sourcePlaceKey, fetchedAt);
    if (!normalized) continue;
    const existing = reviews.get(normalized.review.sourceReviewId);
    // The same review can appear in both arrays; keep the longer text.
    if (!existing || normalized.review.text.length > existing.text.length) {
      reviews.set(normalized.review.sourceReviewId, normalized.review);
    }
    for (const photo of normalized.photos) photos.set(photo.id, photo);
  }
  for (const image of entry.images ?? []) {
    if (!isHttpUrl(image.image)) continue;
    const id = stableId("pho", sourcePlaceKey, image.image);
    photos.set(id, {
      id,
      sourcePlaceKey,
      url: image.image,
      ...(nonEmpty(image.title) ? { caption: nonEmpty(image.title) } : {}),
      attribution: {
        name: "Google Maps",
        ...(isHttpUrl(entry.link) ? { url: entry.link } : {}),
      },
      source: "google",
      provider: "gosom",
      fetchedAt,
    });
  }

  const priceText = nonEmpty(entry.price_range);
  const priceLevel = priceLevelFromText(priceText);
  const types = [
    ...new Set([...(entry.categories ?? []), entry.category ?? ""].filter((t) => t.trim())),
  ];
  const collected = reviews.size;
  const collection = entry.review_collection;

  const place = placeSnapshotSchema.parse({
    sourcePlaceKey,
    ...(nonEmpty(entry.place_id) ? { googlePlaceId: nonEmpty(entry.place_id) } : {}),
    ...(entry.cid && /^\d+$/.test(entry.cid) ? { cid: entry.cid } : {}),
    ...(isHttpUrl(entry.link) ? { googleUrl: entry.link } : {}),
    name: entry.title.trim(),
    lat,
    lng,
    ...(nonEmpty(entry.address) ? { address: nonEmpty(entry.address) } : {}),
    ...(entry.review_rating ? { rating: entry.review_rating } : {}),
    ...(entry.review_count !== undefined ? { ratingCount: entry.review_count } : {}),
    ...(histogram(entry.reviews_per_rating)
      ? { ratingHistogram: histogram(entry.reviews_per_rating) }
      : {}),
    ...(priceLevel ? { priceLevel } : priceText ? { priceText } : {}),
    types,
    ...(nonEmpty(entry.web_site) ? { website: nonEmpty(entry.web_site) } : {}),
    ...(nonEmpty(entry.phone) ? { phone: nonEmpty(entry.phone) } : {}),
    ...(openingHoursLines(entry.open_hours ?? undefined)
      ? { openingHours: openingHoursLines(entry.open_hours ?? undefined) }
      : {}),
    ...(nonEmpty(entry.description) ? { description: nonEmpty(entry.description) } : {}),
    ...(nonEmpty(entry.status) ? { businessStatus: nonEmpty(entry.status) } : {}),
    ...(nonEmpty(entry.timezone) ? { timezone: nonEmpty(entry.timezone) } : {}),
    reviewCollection: {
      status: collection ? collectionStatus(collection.status) : "unknown",
      collected,
      ...(entry.review_count !== undefined ? { expected: entry.review_count } : {}),
      ...(nonEmpty(collection?.reason) ? { reason: nonEmpty(collection?.reason) } : {}),
    },
    provider: "gosom",
    fetchedAt,
  });

  return { place, reviews: [...reviews.values()], photos: [...photos.values()] };
}

/** The scraper writes JSON Lines; accept a JSON array too. */
export function parseResults(text: string): GosomEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as GosomEntry[];
  return trimmed
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GosomEntry);
}

/** Match results back to inputs via the `#!#<index>` custom ids. */
export function collectResults(
  entries: GosomEntry[],
  inputCount: number,
  fetchedAt: string,
): ProviderResult {
  const places: HarvestedPlace[] = [];
  const failures: ProviderResult["failures"] = [];
  for (const entry of entries) {
    const inputIndex = Number(entry.input_id);
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= inputCount) continue;
    const normalized = normalizeGosomEntry(entry, fetchedAt);
    if ("error" in normalized) failures.push({ inputIndex, error: normalized.error });
    else places.push({ inputIndex, ...normalized });
  }
  return { places, failures };
}

// ---------- Running the scraper ----------

export interface GosomConfig {
  /** Run this binary instead of Docker. */
  binary?: string;
  image: string;
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], signal });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

export function gosomProvider(config: GosomConfig): Provider {
  return {
    name: "gosom",
    async harvest(inputs, options) {
      await mkdir(options.workDir, { recursive: true });
      const inputPath = path.join(options.workDir, "queries.txt");
      const resultsPath = path.join(options.workDir, "results.json");
      await writeFile(inputPath, buildInputFile(inputs));
      await rm(resultsPath, { force: true });

      if (config.binary) {
        await run(
          config.binary,
          buildScraperArgs(options, { input: inputPath, results: resultsPath }),
          options.signal,
        );
      } else {
        const workDir = path.resolve(options.workDir);
        await run(
          "docker",
          [
            "run",
            "--rm",
            "-v",
            "placemarks-gosom-cache:/opt",
            "-v",
            `${workDir}:/work`,
            config.image,
            ...buildScraperArgs(options, {
              input: "/work/queries.txt",
              results: "/work/results.json",
            }),
          ],
          options.signal,
        );
      }

      const text = await readFile(resultsPath, "utf8").catch(() => "");
      return collectResults(parseResults(text), inputs.length, new Date().toISOString());
    },
  };
}
