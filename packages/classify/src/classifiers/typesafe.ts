/**
 * TypeSafe Jev classifier (https://docs.typesafe.ai). Jev answers fixed
 * questions — choice, yes/no ("noul"), score — with calibrated probabilities,
 * so it fills the fixed-vocabulary half of the scheme: usefulness, sentiment,
 * aspect sentiment, price, occasions, dietary, vibes, practical flags and red
 * flags. It extracts no dishes and no quotes, and cannot summarise.
 *
 * One review per request (`state`), all questions in parallel inside it.
 * Raw REST, key from TYPESAFE_API_KEY.
 */
import {
  ASPECTS,
  DIETARY,
  OCCASIONS,
  PRICE_SIGNALS,
  RED_FLAGS,
  type ReviewInput,
  VIBES,
  vocabLabel,
} from "@placemarks/domain";
import type { ReviewExtraction } from "../schema";
import { ClassifierError, type ReviewClassifier } from "./types";

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";

type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: "score"; score: number; confidence?: number };

const SENTIMENT_CHOICES: Record<string, string> = {
  not_mentioned: "The review does not talk about this",
  very_negative: "Strongly negative",
  negative: "Somewhat negative",
  neutral: "Neutral or mixed",
  positive: "Somewhat positive",
  very_positive: "Strongly positive",
};
const SENTIMENT_VALUE: Record<string, -2 | -1 | 0 | 1 | 2> = {
  very_negative: -2,
  negative: -1,
  neutral: 0,
  positive: 1,
  very_positive: 2,
};

const ASPECT_TEXT: Record<string, string> = {
  food: "the food and drink",
  service: "the service and staff",
  value: "value for money",
  ambience: "the atmosphere and decor",
  wait: "waiting time to be seated or served",
  cleanliness: "cleanliness",
};

/** The fixed question set, keyed by answer name. Exported for tests. */
export function jevQuestions(): Record<string, Question> {
  const q: Record<string, Question> = {
    useful: {
      type: "noul",
      instructions:
        "Is this a genuine review describing an experience at the place (not spam, empty, or off-topic)?",
    },
    sentiment: {
      type: "score",
      instructions: "How does the reviewer feel about the place overall?",
      criteria: ["Very negative", "Negative", "Neutral or mixed", "Positive", "Very positive"],
    },
    price: {
      type: "choice",
      instructions: "What does the review say about how expensive the place is?",
      criteria: {
        not_mentioned: "Price is not mentioned",
        cheap: "Cheap or very affordable",
        moderate: "Moderately priced",
        pricey: "Pricey",
        very_expensive: "Very expensive",
      },
    },
    reservation_advised: {
      type: "noul",
      instructions: "Does the reviewer say booking or a reservation is advisable?",
    },
    cash_only: { type: "noul", instructions: "Does the review say the place only takes cash?" },
  };
  for (const a of ASPECTS) {
    q[`aspect_${a}`] = {
      type: "choice",
      instructions: `How does the reviewer describe ${ASPECT_TEXT[a]}?`,
      criteria: SENTIMENT_CHOICES,
    };
  }
  for (const v of VIBES) {
    q[`vibe_${v}`] = {
      type: "noul",
      instructions: `Does the review describe the atmosphere as ${vocabLabel(v).toLowerCase()}?`,
    };
  }
  for (const o of OCCASIONS) {
    q[`occasion_${o}`] = {
      type: "noul",
      instructions: `Does the reviewer say the place suits or was visited for: ${vocabLabel(o).toLowerCase()}?`,
    };
  }
  for (const d of DIETARY) {
    q[`dietary_${d}`] = {
      type: "choice",
      instructions: `What does the review say about ${vocabLabel(d).toLowerCase()} options?`,
      criteria: {
        not_mentioned: "Not mentioned",
        well: "Well served, good options",
        poorly: "Poorly served, few or bad options",
      },
    };
  }
  for (const f of RED_FLAGS) {
    q[`flag_${f}`] = {
      type: "noul",
      instructions: `Does the review report a concrete problem with: ${vocabLabel(f).toLowerCase()}?`,
    };
  }
  return q;
}

/** Jev answers → the shared extraction shape (no dishes, no quotes). Exported for tests. */
export function fromJevAnswers(
  id: string,
  answers: Record<string, Answer>,
  yes = 0.6,
): ReviewExtraction {
  const noul = (k: string) => {
    const a = answers[k];
    return a?.type === "noul" ? a.noul : 0;
  };
  const choice = (k: string) => {
    const a = answers[k];
    return a?.type === "choice" ? a.choice : undefined;
  };
  const scoreAnswer = answers.sentiment;
  const sentiment = scoreAnswer?.type === "score" ? Math.round(scoreAnswer.score) - 2 : 0;
  const price = choice("price");
  return {
    id,
    useful: noul("useful") >= 0.5,
    language: null,
    sentiment,
    aspects: ASPECTS.flatMap((aspect) => {
      const value = SENTIMENT_VALUE[choice(`aspect_${aspect}`) ?? ""];
      return value === undefined ? [] : [{ aspect, sentiment: value, quote: "" }];
    }),
    dishes: [],
    price:
      price && (PRICE_SIGNALS as readonly string[]).includes(price)
        ? { signal: price as (typeof PRICE_SIGNALS)[number], amount: null, currency: null }
        : null,
    occasions: OCCASIONS.filter((o) => noul(`occasion_${o}`) >= yes),
    dietary: DIETARY.flatMap((tag) => {
      const c = choice(`dietary_${tag}`);
      return c === "well" || c === "poorly" ? [{ tag, served: c }] : [];
    }),
    vibes: VIBES.filter((v) => noul(`vibe_${v}`) >= yes),
    practical: {
      reservation_advised: noul("reservation_advised") >= yes ? true : null,
      wait_minutes: null,
      cash_only: noul("cash_only") >= yes ? true : null,
    },
    red_flags: RED_FLAGS.filter((f) => noul(`flag_${f}`) >= yes).map((flag) => ({
      flag,
      quote: "",
    })),
  };
}

export interface TypesafeClassifierOptions {
  model?: string;
  apiKey?: string;
  /** Probability at or above which a yes/no question counts as yes. */
  yesThreshold?: number;
  concurrency?: number;
  fetch?: typeof fetch;
  url?: string;
}

export class TypesafeClassifier implements ReviewClassifier {
  readonly id: string;
  readonly chunkSize: number;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly yes: number;
  private readonly doFetch: typeof fetch;
  private readonly url: string;

  constructor(opts: TypesafeClassifierOptions = {}) {
    this.model = opts.model ?? DEFAULT_JEV_MODEL;
    this.id = `typesafe:${this.model}`;
    const key = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!key)
      throw new ClassifierError(
        "Set TYPESAFE_API_KEY to use Jev (keys at console.typesafe.ai/keys)",
      );
    this.apiKey = key;
    this.yes = opts.yesThreshold ?? 0.6;
    this.chunkSize = opts.concurrency ?? 8;
    this.doFetch = opts.fetch ?? fetch;
    this.url = opts.url ?? TYPESAFE_URL;
  }

  /** One request per review, the chunk's reviews in parallel. */
  classify(reviews: ReviewInput[]): Promise<ReviewExtraction[]> {
    return Promise.all(reviews.map((r) => this.one(r)));
  }

  private async one(review: ReviewInput): Promise<ReviewExtraction> {
    const res = await this.doFetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        state: { review: review.text, rating: review.rating ?? null },
        questions: jevQuestions(),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ClassifierError(
        `TypeSafe ${res.status}: ${body.slice(0, 200)}`,
        res.status === 429 || res.status >= 500,
      );
    }
    const json = (await res.json()) as { answers?: Record<string, Answer> };
    if (!json.answers) throw new ClassifierError("TypeSafe response had no answers");
    return fromJevAnswers(review.id, json.answers, this.yes);
  }
}
