/**
 * Claude classifier (default: Claude Haiku 5.5). Structured outputs via the
 * SDK's zod helper; the system prompt is byte-stable and marked cacheable.
 * Credentials resolve the SDK's usual way (ANTHROPIC_API_KEY, or an
 * `ant auth login` profile) — nothing is stored by this package.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { PlaceProfile, ReviewInput } from "@placemarks/domain";
import {
  EXTRACTION_SYSTEM,
  extractionUserMessage,
  SUMMARY_SYSTEM,
  summaryUserMessage,
} from "../prompt";
import {
  extractionBatchSchema,
  type ReviewExtraction,
  type SummaryOutput,
  summarySchema,
} from "../schema";
import { ClassifierError, type ReviewClassifier } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

export interface AnthropicClassifierOptions {
  model?: string;
  effort?: "low" | "medium" | "high";
  chunkSize?: number;
  /** Explicit key (the hosted service's secret); absent, the SDK's usual lookup. */
  apiKey?: string;
  client?: Pick<Anthropic, "messages">;
}

export class AnthropicClassifier implements ReviewClassifier {
  readonly id: string;
  readonly chunkSize: number;
  private readonly model: string;
  private readonly effort: "low" | "medium" | "high";
  private readonly client: Pick<Anthropic, "messages">;

  constructor(opts: AnthropicClassifierOptions = {}) {
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.effort = opts.effort ?? "low";
    this.chunkSize = opts.chunkSize ?? 20;
    this.id = `anthropic:${this.model}`;
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async classify(reviews: ReviewInput[], ctx: { placeName?: string }): Promise<ReviewExtraction[]> {
    const response = await this.call(
      EXTRACTION_SYSTEM,
      extractionUserMessage(reviews, ctx.placeName),
      extractionBatchSchema,
    );
    return response.reviews;
  }

  async summarise(
    profile: PlaceProfile,
    evidence: { reviewId: string; kind: string; quote: string }[],
    ctx: { placeName?: string },
  ): Promise<SummaryOutput> {
    return this.call(
      SUMMARY_SYSTEM,
      summaryUserMessage(profile, evidence, ctx.placeName),
      summarySchema,
    );
  }

  private async call<S extends typeof extractionBatchSchema | typeof summarySchema>(
    system: string,
    user: string,
    schema: S,
  ) {
    let response: Awaited<ReturnType<Anthropic["messages"]["parse"]>>;
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: { effort: this.effort, format: zodOutputFormat(schema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        throw new ClassifierError(err.message, true);
      }
      if (err instanceof Anthropic.APIConnectionError) throw new ClassifierError(err.message, true);
      if (err instanceof Anthropic.APIError)
        throw new ClassifierError(`Anthropic API ${err.status}: ${err.message}`);
      throw err;
    }
    if (response.stop_reason === "refusal")
      throw new ClassifierError("The model declined this request");
    if (response.stop_reason === "max_tokens") {
      throw new ClassifierError("Output hit max_tokens; use a smaller chunk size");
    }
    if (response.parsed_output == null)
      throw new ClassifierError("The response did not match the schema");
    return response.parsed_output as import("zod").infer<S>;
  }
}
