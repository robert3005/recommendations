/**
 * The real fetch and classify steps behind /i/places, for the Worker: SerpApi
 * for the place and its newest reviews, Claude Haiku for the reading. Kept
 * apart from insights.ts so the route's tests need neither.
 */
import { AnthropicClassifier } from "@placemarks/classify/src/classifiers/anthropic";
import { classifyPlace } from "@placemarks/classify/src/pipeline";
import { serpApiClient } from "@placemarks/harvester/serpapi-client";
import type { FetchedPlace, InsightsOptions, InsightsRequest } from "./insights";

export interface ProviderKeys {
  serpApiKey: string;
  anthropicApiKey: string;
  /** Reviews read per place, newest first (SerpApi pages of ~20, one credit each). */
  maxReviews?: number;
  model?: string;
}

export function insightsProviders(
  keys: ProviderKeys,
): Required<Pick<InsightsOptions, "fetchPlace" | "classify">> {
  const classifier = new AnthropicClassifier({
    apiKey: keys.anthropicApiKey,
    ...(keys.model ? { model: keys.model } : {}),
    chunkSize: 25,
  });

  return {
    async fetchPlace(request: InsightsRequest): Promise<FetchedPlace | undefined> {
      const client = serpApiClient({ apiKey: keys.serpApiKey, maxReviews: keys.maxReviews ?? 50 });
      const options = { language: "en", depth: 1 } as const;
      const raw = await client.placeByKey(request, options);
      if (!raw) return undefined;
      const harvested = await client.harvestPlace(raw, 0, options);
      if ("error" in harvested) throw new Error(harvested.error);
      const { place, reviews, photos } = harvested;
      return {
        place: {
          name: place.name,
          ...(place.rating !== undefined ? { rating: place.rating } : {}),
          ...(place.ratingCount !== undefined ? { ratingCount: place.ratingCount } : {}),
          ...(place.priceLevel !== undefined ? { priceLevel: place.priceLevel } : {}),
          ...(place.reviewCollection ? { reviewCollection: place.reviewCollection } : {}),
        },
        reviews: reviews.map((r) => ({
          id: r.id,
          text: r.text,
          rating: r.rating,
          publishedAt: r.publishedAt,
          contentHash: r.contentHash,
        })),
        // Place photos first, then review photos; at most 24 travel to the app.
        photos: photos
          .filter((p): p is typeof p & { url: string } => typeof p.url === "string")
          .sort((a, b) => Number(Boolean(a.reviewId)) - Number(Boolean(b.reviewId)))
          .slice(0, 24)
          .map((p) => ({
            id: p.id,
            url: p.url,
            ...(p.caption ? { caption: p.caption } : {}),
            attribution: p.attribution,
            source: p.source,
          })),
      };
    },

    async classify(place, previous) {
      const result = await classifyPlace(
        { ...place, ...(previous ? { previous } : {}) },
        classifier,
        // Workers have no timers worth waiting on between retries.
        { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2000))) },
      );
      return result.analyses.length > 0 ? result.profile : undefined;
    },
  };
}
