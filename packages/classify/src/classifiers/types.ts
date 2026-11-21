import type { PlaceProfile, ReviewInput } from "@placemarks/domain";
import type { ReviewExtraction, SummaryOutput } from "../schema";

/**
 * One way of reading reviews. LLM classifiers fill every field; Jev fills the
 * fixed-vocabulary fields only (no dishes, no quotes) and cannot summarise.
 */
export interface ReviewClassifier {
  /** Stamped on every analysis, e.g. "anthropic:claude-haiku-5-5". */
  readonly id: string;
  /** How many reviews one classify() call should get. */
  readonly chunkSize: number;
  classify(reviews: ReviewInput[], ctx: { placeName?: string }): Promise<ReviewExtraction[]>;
  summarise?(
    profile: PlaceProfile,
    evidence: { reviewId: string; kind: string; quote: string }[],
    ctx: { placeName?: string },
  ): Promise<SummaryOutput>;
}

export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}
