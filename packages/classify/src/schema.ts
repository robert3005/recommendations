/**
 * The model-facing output schemas and their conversion into domain rows.
 *
 * Every field is required (nullable where absent) and every object is strict,
 * so the same schema works for Anthropic structured outputs and for OpenAI
 * strict JSON schema (Codex `--output-schema`).
 */
import {
  ASPECTS,
  clampSentiment,
  DIETARY,
  keepVerbatimEvidence,
  normalizeDish,
  OCCASIONS,
  type PlaceSummary,
  PRICE_SIGNALS,
  RED_FLAGS,
  type ReviewAnalysis,
  type ReviewInput,
  VIBES,
} from "@placemarks/domain";
import { z } from "zod";

const sentiment = z
  .number()
  .describe("-2 very negative, -1 negative, 0 neutral or mixed, 1 positive, 2 very positive");
const quote = z.string().describe("A short phrase copied verbatim from the review");

export const reviewExtractionSchema = z.strictObject({
  id: z.string().describe("The review id exactly as given"),
  useful: z.boolean().describe("False for spam, empty, one-word or off-topic reviews"),
  language: z.string().nullable().describe("ISO 639-1 code of the review text"),
  sentiment,
  aspects: z.array(z.strictObject({ aspect: z.enum(ASPECTS), sentiment, quote })),
  dishes: z.array(
    z.strictObject({
      name: z.string().describe("The dish or drink as the reviewer wrote it"),
      normalized: z
        .string()
        .describe("Lowercase canonical dish name in English, without adjectives"),
      sentiment,
      quote,
    }),
  ),
  price: z
    .strictObject({
      signal: z.enum(PRICE_SIGNALS),
      amount: z.number().nullable().describe("A price per person mentioned in the review, if any"),
      currency: z.string().nullable().describe("ISO 4217 code for amount"),
    })
    .nullable(),
  occasions: z.array(z.enum(OCCASIONS)),
  dietary: z.array(z.strictObject({ tag: z.enum(DIETARY), served: z.enum(["well", "poorly"]) })),
  vibes: z.array(z.enum(VIBES)),
  practical: z.strictObject({
    reservation_advised: z.boolean().nullable(),
    wait_minutes: z.number().nullable(),
    cash_only: z.boolean().nullable(),
  }),
  red_flags: z.array(z.strictObject({ flag: z.enum(RED_FLAGS), quote })),
});

export type ReviewExtraction = z.infer<typeof reviewExtractionSchema>;

export const extractionBatchSchema = z.strictObject({
  reviews: z.array(reviewExtractionSchema),
});

export const summarySchema = z.strictObject({
  summary: z.string().describe("Two or three plain sentences on what reviewers say"),
  claims: z.array(
    z.strictObject({
      text: z.string().describe("One sentence of the summary"),
      review_ids: z.array(z.string()).describe("Ids of the reviews that support the sentence"),
    }),
  ),
});

export type SummaryOutput = z.infer<typeof summarySchema>;

export interface AnalysisMeta {
  sourcePlaceKey: string;
  classifier: string;
  promptVersion: string;
  analysedAt: string;
}

/** One model extraction → a domain ReviewAnalysis, with non-verbatim quotes dropped. */
export function toAnalysis(
  x: ReviewExtraction,
  review: ReviewInput,
  meta: AnalysisMeta,
): ReviewAnalysis {
  const optionalQuote = (q: string) => (q.trim() === "" ? undefined : q);
  const analysis: ReviewAnalysis = {
    reviewId: review.id,
    sourcePlaceKey: meta.sourcePlaceKey,
    classifier: meta.classifier,
    promptVersion: meta.promptVersion,
    contentHash: review.contentHash,
    analysedAt: meta.analysedAt,
    useful: x.useful,
    language: x.language ?? undefined,
    sentiment: clampSentiment(x.sentiment),
    aspects: x.aspects.map((a) => ({
      aspect: a.aspect,
      sentiment: clampSentiment(a.sentiment),
      quote: optionalQuote(a.quote),
    })),
    dishes: x.dishes
      .filter((d) => d.name.trim() !== "")
      .map((d) => ({
        name: d.name.trim(),
        normalized: normalizeDish(d.normalized || d.name),
        sentiment: clampSentiment(d.sentiment),
        quote: optionalQuote(d.quote),
      })),
    price: x.price
      ? {
          signal: x.price.signal,
          amount: x.price.amount ?? undefined,
          currency: x.price.currency ?? undefined,
        }
      : undefined,
    occasions: [...new Set(x.occasions)],
    dietary: x.dietary,
    vibes: [...new Set(x.vibes)],
    practical: {
      reservationAdvised: x.practical.reservation_advised ?? undefined,
      waitMinutes: x.practical.wait_minutes ?? undefined,
      cashOnly: x.practical.cash_only ?? undefined,
    },
    redFlags: x.red_flags.map((r) => ({ flag: r.flag, quote: optionalQuote(r.quote) })),
  };
  return keepVerbatimEvidence(analysis, review.text);
}

/** Model summary → domain PlaceSummary, keeping only review ids that exist. */
export function toSummary(
  out: SummaryOutput,
  knownIds: Set<string>,
  classifier: string,
  createdAt: string,
): PlaceSummary {
  return {
    text: out.summary.trim(),
    claims: out.claims
      .map((c) => ({
        text: c.text.trim(),
        reviewIds: [...new Set(c.review_ids)].filter((id) => knownIds.has(id)),
      }))
      .filter((c) => c.text !== ""),
    classifier,
    createdAt,
  };
}
