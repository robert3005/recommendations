/**
 * Prompts shared by every LLM classifier. Bump PROMPT_VERSION whenever the
 * wording or the schema changes: analyses stamped with an older version are
 * re-run on the next pass.
 */
import {
  ASPECTS,
  DIETARY,
  OCCASIONS,
  type PlaceProfile,
  PRICE_SIGNALS,
  RED_FLAGS,
  type ReviewInput,
  VIBES,
} from "@placemarks/domain";

export const PROMPT_VERSION = "2026-11-21.2";

/** Byte-stable across calls so prompt caching can apply. */
export const EXTRACTION_SYSTEM = `You read restaurant and venue reviews and extract structured facts for a personal place atlas.

For every review you are given, return one entry with the same id. Read only what the review itself says; never guess or add outside knowledge.

Rules:
- sentiment: the reviewer's overall feeling, -2 very negative to 2 very positive. Mixed reviews are 0.
- aspects: include an aspect only when the review talks about it. Aspects: ${ASPECTS.join(", ")}. "value" is price relative to what you get; "wait" is time to be seated or served.
- dishes: every specific dish or drink the reviewer mentions with an opinion. name is as written; normalized is the plain English dish name in lowercase ("cacio e pepe", "flat white").
- price: only when the review signals how expensive it is (${PRICE_SIGNALS.join(", ")}). amount is a per-person figure only if the review states one.
- occasions (${OCCASIONS.join(", ")}): only when the reviewer says the place suits or was used for it.
- dietary (${DIETARY.join(", ")}): only when the review says how well that diet is served.
- vibes (${VIBES.join(", ")}): only when the review describes the atmosphere that way.
- practical: reservation_advised, wait_minutes (a typical wait the reviewer reports) and cash_only, or null when not mentioned.
- red_flags (${RED_FLAGS.join(", ")}): only for concrete reports, not mild complaints.
- Every quote must be a short phrase copied exactly from the review text, at most 12 words, that is specifically about that aspect, dish or flag. A dish quote must name or clearly describe that dish; generic praise like "every dish was delicious" is not a quote for any one dish. Use an empty string if no phrase fits.
- useful is false for spam, empty, one-word or off-topic reviews; still fill the other fields as best you can.
- Return empty arrays when nothing applies.`;

export function extractionUserMessage(reviews: ReviewInput[], placeName?: string): string {
  const lines = reviews.map((r) =>
    JSON.stringify({
      id: r.id,
      rating: r.rating ?? null,
      date: r.publishedAt?.slice(0, 10) ?? null,
      text: r.text,
    }),
  );
  return `${placeName ? `Place: ${placeName}\n` : ""}Reviews (one JSON object per line):\n${lines.join("\n")}`;
}

export const SUMMARY_SYSTEM = `You write the two or three sentence "what people say" line on a place card in a personal place atlas.

You get aggregated facts and short evidence phrases with the ids of the reviews they came from. Write plain, specific sentences: what stands out, what people order, and any consistent complaint. At most three short sentences and 60 words in total. No hype, no second person, no exclamation marks, no remarks about how many reviews there are, and nothing that the evidence does not support. Each sentence is one claim; list the review ids that support it.`;

export function summaryUserMessage(
  profile: PlaceProfile,
  evidence: { reviewId: string; kind: string; quote: string }[],
  placeName?: string,
): string {
  const facts = {
    place: placeName ?? null,
    usefulReviews: profile.usefulCount,
    aspects: profile.aspects.map((a) => ({
      aspect: a.aspect,
      score: Number(a.score.toFixed(2)),
      mentions: a.mentions,
    })),
    topDishes: profile.dishes
      .slice(0, 6)
      .map((d) => ({ name: d.name, mentions: d.mentions, score: Number(d.score.toFixed(2)) })),
    price: profile.price ?? null,
    tags: profile.tags,
    warnings: profile.warnings.map((w) => ({ flag: w.flag, mentions: w.mentions })),
  };
  return `Facts:\n${JSON.stringify(facts, null, 2)}\n\nEvidence:\n${evidence
    .map((e) => JSON.stringify(e))
    .join("\n")}`;
}
