/**
 * SerpApi's Google Maps and Google Maps Reviews APIs, with no file system:
 * the harvester's provider (serpapi.ts) adds a disk cache around it, and the
 * hosted insights service runs it inside a Worker.
 * Unlike anonymous scraping it pages through a place's full review history,
 * so it is the route to review volume. Every request is one SerpApi search
 * credit; `maxReviews` caps the spend per place.
 *
 * Endpoints (https://serpapi.com/google-maps-api, /google-maps-reviews-api):
 *   engine=google_maps&type=search&q=…&ll=@lat,lng,<zoom>z&start=0|20|…
 *   engine=google_maps&place_id=ChIJ…        (single place)
 *   engine=google_maps&type=place&data=!4m5!3m4!1s<data_id>!8m2!3d<lat>!4d<lng>
 *   engine=google_maps_reviews&data_id=…&sort_by=newestFirst&next_page_token=…
 */
import { parsePastedLink } from "@placemarks/domain";
import {
  type HarvestPhoto,
  type HarvestReview,
  type PlaceSnapshot,
  placeSnapshotSchema,
  sourcePlaceKeySchema,
} from "@placemarks/schemas";
import {
  isHttpUrl,
  nonEmpty,
  priceLevelFromText,
  reviewContentHash,
  stableId,
  stringList,
} from "../normalize";
import type { HarvestedPlace, HarvestInput, HarvestOptions, SearchArea } from "./types";

const ENDPOINT = "https://serpapi.com/search.json";

// ---------- SerpApi response shapes (the fields we read) ----------

export interface SerpPlace {
  title?: string;
  place_id?: string;
  data_id?: string;
  data_cid?: string;
  gps_coordinates?: { latitude?: number; longitude?: number };
  address?: string;
  rating?: number;
  reviews?: number;
  price?: string;
  /** A string in search results, a list in place results. */
  type?: string | string[];
  types?: string[];
  website?: string;
  phone?: string;
  description?: string | { snippet?: string };
  open_state?: string;
  operating_hours?: Record<string, string>;
  hours?: Record<string, string>[] | Record<string, string>;
  rating_summary?: { stars?: number; amount?: number }[];
  thumbnail?: string;
  images?: { title?: string; thumbnail?: string; image?: string }[];
  link?: string;
}

export interface SerpReview {
  review_id?: string;
  link?: string;
  rating?: number;
  date?: string;
  iso_date?: string;
  iso_date_of_last_edit?: string;
  snippet?: string;
  extracted_snippet?: { original?: string; translated?: string };
  likes?: number;
  images?: (string | { thumbnail?: string; image?: string })[];
  user?: { name?: string; link?: string };
  response?: {
    iso_date?: string;
    snippet?: string;
    extracted_snippet?: { original?: string; translated?: string };
  };
}

export interface SerpResponse {
  error?: string;
  place_results?: SerpPlace;
  local_results?: SerpPlace[];
  place_info?: { title?: string; address?: string; rating?: number; reviews?: number };
  reviews?: SerpReview[];
  serpapi_pagination?: { next_page_token?: string };
}

export type Fetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Where successful responses are kept, keyed by the request parameters (never the key). */
export interface SerpCache {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, body: unknown): Promise<void>;
}

export interface SerpApiConfig {
  apiKey: string;
  /** Most reviews downloaded per place (each page of ~20 is one credit). */
  maxReviews: number;
  fetch?: Fetch;
  log?: (line: string) => void;
  cache?: SerpCache;
}

// ---------- Normalization ----------

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function openingHours(place: SerpPlace): string[] | undefined {
  const source = place.operating_hours ?? place.hours;
  if (!source) return undefined;
  const entries = Array.isArray(source)
    ? source.flatMap((day) => Object.entries(day))
    : Object.entries(source);
  const lines = entries
    .filter(([, value]) => typeof value === "string")
    .map(([day, value]) => `${day.charAt(0).toUpperCase()}${day.slice(1)}: ${value}`);
  return lines.length > 0 ? lines : undefined;
}

function histogram(place: SerpPlace): PlaceSnapshot["ratingHistogram"] {
  const out: Record<string, number> = {};
  for (const row of place.rating_summary ?? []) {
    if (row.stars && row.stars >= 1 && row.stars <= 5 && Number.isInteger(row.amount)) {
      out[String(row.stars)] = row.amount as number;
    }
  }
  return Object.keys(out).length > 0 ? (out as PlaceSnapshot["ratingHistogram"]) : undefined;
}

export function sourcePlaceKeyOfSerp(place: SerpPlace): string | undefined {
  const candidates = [
    place.data_id?.toLowerCase(),
    place.data_cid && /^\d+$/.test(place.data_cid) ? `cid:${place.data_cid}` : undefined,
  ];
  return candidates.find((key) => key && sourcePlaceKeySchema.safeParse(key).success);
}

/** Whether a result is the place a key names (a `cid:` key also matches by its cid). */
export function serpMatchesKey(place: SerpPlace, sourcePlaceKey: string): boolean {
  if (sourcePlaceKeyOfSerp(place) === sourcePlaceKey) return true;
  return sourcePlaceKey.startsWith("cid:") && `cid:${place.data_cid}` === sourcePlaceKey;
}

export function normalizeSerpPlace(
  raw: SerpPlace,
  reviewsCollected: number,
  capped: boolean,
  fetchedAt: string,
): { place: PlaceSnapshot; photos: HarvestPhoto[] } | { error: string } {
  const sourcePlaceKey = sourcePlaceKeyOfSerp(raw);
  const title = nonEmpty(raw.title);
  if (!sourcePlaceKey) return { error: `no Google id for "${title ?? "?"}"` };
  const lat = raw.gps_coordinates?.latitude;
  const lng = raw.gps_coordinates?.longitude;
  if (!title || typeof lat !== "number" || typeof lng !== "number") {
    return { error: `no name or coordinates for ${sourcePlaceKey}` };
  }
  const priceText = nonEmpty(raw.price);
  const priceLevel = priceLevelFromText(priceText);
  const description =
    typeof raw.description === "string" ? raw.description : nonEmpty(raw.description?.snippet);
  const expected = raw.reviews;
  const googleUrl = raw.place_id
    ? `https://www.google.com/maps/place/?q=place_id:${raw.place_id}`
    : raw.data_cid
      ? `https://maps.google.com/?cid=${raw.data_cid}`
      : undefined;

  const place = placeSnapshotSchema.parse({
    sourcePlaceKey,
    ...(nonEmpty(raw.place_id) ? { googlePlaceId: nonEmpty(raw.place_id) } : {}),
    ...(raw.data_cid && /^\d+$/.test(raw.data_cid) ? { cid: raw.data_cid } : {}),
    ...(googleUrl ? { googleUrl } : {}),
    name: title,
    lat,
    lng,
    ...(nonEmpty(raw.address) ? { address: nonEmpty(raw.address) } : {}),
    ...(raw.rating ? { rating: raw.rating } : {}),
    ...(expected !== undefined ? { ratingCount: expected } : {}),
    ...(histogram(raw) ? { ratingHistogram: histogram(raw) } : {}),
    ...(priceLevel ? { priceLevel } : priceText ? { priceText } : {}),
    types: [...new Set([...stringList(raw.types), ...stringList(raw.type)])],
    ...(nonEmpty(raw.website) ? { website: nonEmpty(raw.website) } : {}),
    ...(nonEmpty(raw.phone) ? { phone: nonEmpty(raw.phone) } : {}),
    ...(openingHours(raw) ? { openingHours: openingHours(raw) } : {}),
    ...(nonEmpty(description) ? { description: nonEmpty(description) } : {}),
    ...(/(permanently|temporarily) closed/i.test(nonEmpty(raw.open_state) ?? "")
      ? { businessStatus: nonEmpty(raw.open_state) }
      : {}),
    reviewCollection: {
      status:
        expected !== undefined && reviewsCollected >= expected
          ? "complete"
          : capped
            ? "partial"
            : "unknown",
      collected: reviewsCollected,
      ...(expected !== undefined ? { expected } : {}),
      ...(capped ? { reason: "stopped at --max-reviews" } : {}),
    },
    provider: "serpapi",
    fetchedAt,
  });

  const photos: HarvestPhoto[] = [];
  for (const image of raw.images ?? []) {
    const url = image.image ?? image.thumbnail;
    if (!isHttpUrl(url)) continue;
    photos.push({
      id: stableId("pho", sourcePlaceKey, url),
      sourcePlaceKey,
      url,
      ...(nonEmpty(image.title) ? { caption: nonEmpty(image.title) } : {}),
      attribution: { name: "Google Maps", ...(googleUrl ? { url: googleUrl } : {}) },
      source: "google",
      provider: "serpapi",
      fetchedAt,
    });
  }
  return { place, photos };
}

export function normalizeSerpReview(
  raw: SerpReview,
  sourcePlaceKey: string,
  fetchedAt: string,
): { review: HarvestReview; photos: HarvestPhoto[] } | undefined {
  const sourceReviewId = nonEmpty(raw.review_id);
  if (!sourceReviewId) return undefined;
  const text = nonEmpty(raw.extracted_snippet?.original) ?? nonEmpty(raw.snippet) ?? "";
  const rating =
    raw.rating && raw.rating >= 1 && raw.rating <= 5 ? Math.round(raw.rating) : undefined;
  if (!text && rating === undefined) return undefined;

  const replyText =
    nonEmpty(raw.response?.extracted_snippet?.original) ?? nonEmpty(raw.response?.snippet);
  const replyAt = isoOrUndefined(raw.response?.iso_date);
  const ownerResponse = replyText
    ? { text: replyText, ...(replyAt ? { publishedAt: replyAt } : {}) }
    : undefined;
  const translated = nonEmpty(raw.extracted_snippet?.translated);
  const authorName = nonEmpty(raw.user?.name);
  const authorUrl = isHttpUrl(raw.user?.link) ? raw.user?.link : undefined;
  const id = stableId("rev", sourcePlaceKey, sourceReviewId);

  const photos: HarvestPhoto[] = (raw.images ?? [])
    .map((image) => (typeof image === "string" ? image : (image.image ?? image.thumbnail)))
    .filter(isHttpUrl)
    .map((url) => ({
      id: stableId("pho", sourcePlaceKey, url),
      sourcePlaceKey,
      reviewId: id,
      url,
      attribution: {
        name: authorName ?? "Google Maps user",
        ...(authorUrl ? { url: authorUrl } : {}),
      },
      source: "google" as const,
      provider: "serpapi" as const,
      fetchedAt,
    }));

  const publishedAt = isoOrUndefined(raw.iso_date);
  const updatedAt = isoOrUndefined(raw.iso_date_of_last_edit);
  const review: HarvestReview = {
    id,
    sourcePlaceKey,
    source: "google",
    sourceReviewId,
    ...(authorName ? { authorName } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    ...(rating !== undefined ? { rating } : {}),
    text,
    ...(translated && translated !== text ? { translatedText: translated } : {}),
    ...(ownerResponse ? { ownerResponse } : {}),
    ...(Number.isInteger(raw.likes) && (raw.likes as number) >= 0 ? { likes: raw.likes } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt && updatedAt !== publishedAt ? { updatedAt } : {}),
    ...(nonEmpty(raw.date) ? { relativeTime: nonEmpty(raw.date) } : {}),
    ...(photos.length > 0 ? { photos: photos.map((p) => p.id) } : {}),
    provider: "serpapi",
    fetchedAt,
    contentHash: reviewContentHash({ rating, text, ownerResponse }),
  };
  return { review, photos };
}

// ---------- Requests ----------

/** `…/maps/search/Katz's+Delicatessen+New+York` → "Katz's Delicatessen New York". */
export function searchTextFromUrl(url: string): string | undefined {
  const match = url.match(/\/maps\/search\/([^/?#@]+)/);
  if (!match?.[1]) return undefined;
  try {
    const text = decodeURIComponent(match[1].replace(/\+/g, " ")).trim();
    // A dropped pin's "search" is a coordinate pair, not a name.
    return text && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** A radius → a map height in metres for `ll` (the visible area ≈ the search area). */
export function llParam(area: SearchArea | undefined): string | undefined {
  if (area?.bbox) {
    const [minLat, minLng, maxLat, maxLng] = area.bbox;
    const heightM = Math.max(1, Math.round((maxLat - minLat) * 111_320));
    return `@${(minLat + maxLat) / 2},${(minLng + maxLng) / 2},${heightM}m`;
  }
  if (area?.geo) {
    const heightM = Math.max(1, Math.round((area.radiusMeters ?? 2000) * 2));
    return `@${area.geo.lat},${area.geo.lng},${heightM}m`;
  }
  return undefined;
}

type RequestOptions = Pick<HarvestOptions, "signal" | "language" | "depth" | "area">;

export function serpApiClient(config: SerpApiConfig) {
  const doFetch: Fetch = config.fetch ?? ((url, init) => fetch(url, init));
  let credits = 0;

  /** One SerpApi request; a cached answer costs no credit. */
  async function call(
    params: Record<string, string>,
    options: Pick<HarvestOptions, "signal">,
  ): Promise<SerpResponse> {
    const cacheKey = JSON.stringify(Object.entries(params).sort());
    const cached = (await config.cache?.get(cacheKey)) as SerpResponse | undefined;
    if (cached) return cached;

    const url = new URL(ENDPOINT);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("api_key", config.apiKey);
    credits++;
    const response = await doFetch(
      url.toString(),
      options.signal ? { signal: options.signal } : undefined,
    );
    const body = (await response.json().catch(() => ({}))) as SerpResponse;
    // SerpApi reports "no results" as an error string; that is an empty answer, not a failure.
    if (body.error && /hasn't returned any results/i.test(body.error)) return {};
    if (!response.ok || body.error) {
      throw new Error(`SerpApi ${params.engine}: ${body.error ?? `HTTP ${response.status}`}`);
    }
    await config.cache?.put(cacheKey, body);
    return body;
  }

  /** The places one input names: a single place for a URL, the result list for a search. */
  async function placesFor(input: HarvestInput, options: RequestOptions): Promise<SerpPlace[]> {
    if (input.kind === "url") {
      const link = parsePastedLink(input.query);
      const google: Extract<NonNullable<typeof link>, { kind: "google" }> | undefined =
        link?.kind === "google" ? link : undefined;
      const dataId = google?.featureId?.startsWith("0x") ? google.featureId : undefined;
      if (dataId && google?.lat !== undefined && google.lng !== undefined) {
        const body = await call(
          {
            engine: "google_maps",
            type: "place",
            data: `!4m5!3m4!1s${dataId}!8m2!3d${google.lat}!4d${google.lng}`,
            hl: options.language,
          },
          options,
        );
        if (body.place_results) return [body.place_results];
      }
      // No usable id + coordinates: search by name and prefer the matching listing.
      const q = searchTextFromUrl(input.query) ?? google?.name ?? input.title ?? input.query;
      const body = await call(
        { engine: "google_maps", type: "search", q, hl: options.language },
        options,
      );
      if (body.place_results) return [body.place_results];
      const results = body.local_results ?? [];
      const match = dataId ? results.find((r) => r.data_id?.toLowerCase() === dataId) : undefined;
      return match ? [match] : results.slice(0, 1);
    }

    const ll = llParam(options.area);
    const places: SerpPlace[] = [];
    for (let page = 0; page < Math.max(1, options.depth); page++) {
      // Pagination needs `ll`; without an area only the first page is fetched.
      if (page > 0 && !ll) break;
      const body = await call(
        {
          engine: "google_maps",
          type: "search",
          q: input.query,
          hl: options.language,
          ...(ll ? { ll } : {}),
          ...(page > 0 ? { start: String(page * 20) } : {}),
        },
        options,
      );
      if (body.place_results) return [body.place_results];
      const results = body.local_results ?? [];
      places.push(...results);
      if (results.length < 20) break;
    }
    return places;
  }

  /** Page through a place's reviews, newest first, up to `maxReviews`. */
  async function reviewsFor(dataId: string, options: RequestOptions) {
    const raw: SerpReview[] = [];
    let token: string | undefined;
    do {
      const body = await call(
        {
          engine: "google_maps_reviews",
          data_id: dataId,
          sort_by: "newestFirst",
          hl: options.language,
          ...(token ? { next_page_token: token, num: "20" } : {}),
        },
        options,
      );
      raw.push(...(body.reviews ?? []));
      token = body.serpapi_pagination?.next_page_token;
    } while (token && raw.length < config.maxReviews && !options.signal?.aborted);
    return { raw: raw.slice(0, config.maxReviews), capped: Boolean(token) };
  }

  /**
   * The listing for one known place: by feature id and coordinates when both
   * are known, else a name search around the coordinates. Only a result whose
   * Google id is `sourcePlaceKey` counts, so a search never returns a
   * different place that happens to share the name.
   */
  async function placeByKey(
    target: { sourcePlaceKey: string; name?: string; lat?: number; lng?: number },
    options: RequestOptions,
  ): Promise<SerpPlace | undefined> {
    const { sourcePlaceKey, name, lat, lng } = target;
    const hasCoords = typeof lat === "number" && typeof lng === "number";
    if (sourcePlaceKey.startsWith("0x") && hasCoords) {
      const body = await call(
        {
          engine: "google_maps",
          type: "place",
          data: `!4m5!3m4!1s${sourcePlaceKey}!8m2!3d${lat}!4d${lng}`,
          hl: options.language,
        },
        options,
      );
      if (body.place_results && serpMatchesKey(body.place_results, sourcePlaceKey)) {
        return body.place_results;
      }
    }
    if (!name) return undefined;
    const ll = hasCoords ? llParam({ geo: { lat, lng }, radiusMeters: 500 }) : undefined;
    const body = await call(
      {
        engine: "google_maps",
        type: "search",
        q: name,
        hl: options.language,
        ...(ll ? { ll } : {}),
      },
      options,
    );
    const candidates = body.place_results ? [body.place_results] : (body.local_results ?? []);
    return candidates.find((p) => serpMatchesKey(p, sourcePlaceKey));
  }

  /** Reviews (unless `extraReviews` is off) and normalization for one place result. */
  async function harvestPlace(
    raw: SerpPlace,
    inputIndex: number,
    options: RequestOptions & { extraReviews?: boolean },
  ): Promise<HarvestedPlace | { error: string }> {
    const fetchedAt = new Date().toISOString();
    const key = sourcePlaceKeyOfSerp(raw);
    const reviews = new Map<string, HarvestReview>();
    const photos = new Map<string, HarvestPhoto>();
    let capped = false;
    if (key && raw.data_id && options.extraReviews !== false) {
      const fetched = await reviewsFor(raw.data_id, options);
      capped = fetched.capped;
      for (const r of fetched.raw) {
        const normalized = normalizeSerpReview(r, key, fetchedAt);
        if (!normalized) continue;
        reviews.set(normalized.review.sourceReviewId, normalized.review);
        for (const p of normalized.photos) photos.set(p.id, p);
      }
    }
    const place = normalizeSerpPlace(raw, reviews.size, capped, fetchedAt);
    if ("error" in place) return place;
    for (const p of place.photos) photos.set(p.id, p);
    return {
      inputIndex,
      place: place.place,
      reviews: [...reviews.values()],
      photos: [...photos.values()],
    };
  }

  return {
    placesFor,
    placeByKey,
    reviewsFor,
    harvestPlace,
    /** Requests sent so far (cache hits excluded): one SerpApi credit each. */
    get credits() {
      return credits;
    },
  };
}
