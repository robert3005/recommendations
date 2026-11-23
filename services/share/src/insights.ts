/**
 * Hosted review insights (spec/src/reviews.md §Hosted on import): the app
 * names a Google place, the service fetches its facts, photos and reviews
 * (SerpApi), classifies the reviews (Claude Haiku) and answers with what was
 * learned. Review text lives only in this request's memory: the service keeps
 * the answer — place facts, photo links, the profile — and never the reviews.
 *
 * Every lookup that reaches SerpApi or the model costs money, so the route
 * needs the operator's access key and draws on a daily place budget. A cached
 * answer is free and is served for a month; `refresh` refetches one older
 * than a week.
 */
import type { PlaceProfile, ReviewInput } from "@placemarks/domain";
import { sourcePlaceKeySchema } from "@placemarks/schemas";
import { bearerToken, sha256Hex, timingSafeEqualHex } from "@placemarks/service-kit";
import type { Hono } from "hono";

export interface InsightsStorage {
  getInsights(sourcePlaceKey: string): Promise<{ body: string; fetchedAt: string } | undefined>;
  putInsights(sourcePlaceKey: string, body: string, fetchedAt: string): Promise<void>;
  hit(bucket: string, windowMs: number, now: number): Promise<number>;
}

/** What the app needs to request one place. */
export interface InsightsRequest {
  sourcePlaceKey: string;
  name?: string;
  lat?: number;
  lng?: number;
}

/** One place as the harvest provider returns it; reviews never leave this module. */
export interface FetchedPlace {
  place: {
    name: string;
    rating?: number;
    ratingCount?: number;
    priceLevel?: number;
    reviewCollection?: { status: string; collected: number; expected?: number };
  };
  reviews: ReviewInput[];
  photos: {
    id: string;
    url: string;
    caption?: string;
    attribution: { name: string; url?: string };
    source: string;
  }[];
}

/** The answer, and the cached record. Carries no review text. */
export interface InsightsPayload {
  sourcePlaceKey: string;
  fetchedAt: string;
  place: FetchedPlace["place"];
  photos: FetchedPlace["photos"];
  /** Reviews read; written ones (with text) are what was classified. */
  reviewCount: number;
  writtenCount: number;
  profile?: PlaceProfile;
}

export interface InsightsOptions {
  storage: InsightsStorage;
  /** The operator's key; absent, the route answers 501. */
  accessKey?: string;
  /** Absent (no SerpApi or Anthropic key configured), the route answers 501. */
  fetchPlace?: (request: InsightsRequest) => Promise<FetchedPlace | undefined>;
  classify?: (
    place: { sourcePlaceKey: string; name: string; reviews: ReviewInput[] },
    previous: PlaceProfile | undefined,
  ) => Promise<PlaceProfile | undefined>;
  /** Places fetched (not served from cache) per rolling day. */
  dailyPlaces?: number;
  now?: () => number;
}

export const INSIGHTS_LIMITS = {
  dailyPlaces: 100,
  /** A cached answer is served without a refetch for this long… */
  freshMs: 30 * 86_400_000,
  /** …and `refresh` refetches only an answer older than this. */
  refreshAfterMs: 7 * 86_400_000,
  requestBytes: 4096,
} as const;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function mountInsights(app: Hono, options: InsightsOptions): void {
  const now = options.now ?? Date.now;
  const dailyPlaces = options.dailyPlaces ?? INSIGHTS_LIMITS.dailyPlaces;

  app.use("/i/*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
  });
  app.options("/i/*", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "86400",
    }),
  );

  app.post("/i/places", async (c) => {
    const { storage, accessKey, fetchPlace, classify } = options;
    if (!accessKey || !fetchPlace || !classify) {
      return c.text("review insights are not set up on this service", 501, NO_STORE);
    }
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return c.text("missing access key", 401, NO_STORE);
    const source = c.req.header("cf-connecting-ip") ?? "local";
    if ((await storage.hit(`i:auth:${source}`, 60_000, now())) > 60) {
      return c.text("rate limited", 429, NO_STORE);
    }
    if (!timingSafeEqualHex(await sha256Hex(token), await sha256Hex(accessKey))) {
      return c.text("wrong access key", 403, NO_STORE);
    }

    const raw = await c.req.text();
    if (raw.length > INSIGHTS_LIMITS.requestBytes) return c.text("too large", 413, NO_STORE);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return c.text("invalid JSON", 400, NO_STORE);
    }
    const key = sourcePlaceKeySchema.safeParse(body.sourcePlaceKey);
    if (!key.success) return c.text("invalid sourcePlaceKey", 400, NO_STORE);
    const request: InsightsRequest = {
      sourcePlaceKey: key.data,
      ...(typeof body.name === "string" && body.name.trim()
        ? { name: body.name.trim().slice(0, 200) }
        : {}),
      ...(finite(body.lat) !== undefined && finite(body.lng) !== undefined
        ? { lat: finite(body.lat), lng: finite(body.lng) }
        : {}),
    };

    const cached = await storage.getInsights(request.sourcePlaceKey);
    const age = cached ? now() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY;
    const wantsRefresh = body.refresh === true && age > INSIGHTS_LIMITS.refreshAfterMs;
    if (cached && age < INSIGHTS_LIMITS.freshMs && !wantsRefresh) {
      return c.body(cached.body, 200, {
        ...NO_STORE,
        "Content-Type": "application/json; charset=utf-8",
        "X-Insights": "cached",
      });
    }

    if ((await storage.hit("i:day", 86_400_000, now())) > dailyPlaces) {
      return c.text("today's review-insights budget is used up; try again tomorrow", 429, NO_STORE);
    }

    let fetched: FetchedPlace | undefined;
    try {
      fetched = await fetchPlace(request);
    } catch (error) {
      return c.text(`review download failed: ${message(error)}`, 502, NO_STORE);
    }
    if (!fetched) return c.text("Google has no listing for this place", 404, NO_STORE);

    const written = fetched.reviews.filter((r) => r.text.trim() !== "");
    const previous = cached ? (JSON.parse(cached.body) as InsightsPayload).profile : undefined;
    let profile: PlaceProfile | undefined;
    if (written.length > 0) {
      try {
        profile = await classify(
          {
            sourcePlaceKey: request.sourcePlaceKey,
            name: fetched.place.name,
            reviews: fetched.reviews.map(({ id, text, rating, publishedAt, contentHash }) => ({
              id,
              text,
              rating,
              publishedAt,
              contentHash,
            })),
          },
          previous,
        );
      } catch (error) {
        return c.text(`classification failed: ${message(error)}`, 502, NO_STORE);
      }
      if (!profile) return c.text("classification failed: no review was read", 502, NO_STORE);
    }

    const fetchedAt = new Date(now()).toISOString();
    const payload: InsightsPayload = {
      sourcePlaceKey: request.sourcePlaceKey,
      fetchedAt,
      place: fetched.place,
      photos: fetched.photos,
      reviewCount: fetched.reviews.length,
      writtenCount: written.length,
      ...(profile ? { profile: { ...profile, sourcePlaceKey: request.sourcePlaceKey } } : {}),
    };
    const json = JSON.stringify(payload);
    await storage.putInsights(request.sourcePlaceKey, json, fetchedAt);
    return c.body(json, 200, {
      ...NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      "X-Insights": "fetched",
    });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
