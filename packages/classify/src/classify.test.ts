import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewAnalysis, ReviewInput } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { AnthropicClassifier } from "./classifiers/anthropic";
import { CodexClassifier, type Runner } from "./classifiers/codex";
import { ClassifierError, type ReviewClassifier } from "./classifiers/types";
import { fromJevAnswers, jevQuestions, TypesafeClassifier } from "./classifiers/typesafe";
import { compareAnalyses, formatAgreement } from "./compare";
import { PROMPT_VERSION } from "./prompt";
import { analysePlace, loadPlaceFolder } from "./run";
import { type ReviewExtraction, toAnalysis, toSummary } from "./schema";

const NOW = "2026-11-21T00:00:00.000Z";
const review = (id: string, text: string): ReviewInput => ({ id, text, contentHash: `h-${id}` });

function extraction(id: string, over: Partial<ReviewExtraction> = {}): ReviewExtraction {
  return {
    id,
    useful: true,
    language: "en",
    sentiment: 2,
    aspects: [],
    dishes: [],
    price: null,
    occasions: [],
    dietary: [],
    vibes: [],
    practical: { reservation_advised: null, wait_minutes: null, cash_only: null },
    red_flags: [],
    ...over,
  };
}

describe("toAnalysis", () => {
  it("clamps, normalizes, dedupes and keeps only verbatim quotes", () => {
    const r = review("r1", "The cacio e pepe was superb but the waiter was rude.");
    const a = toAnalysis(
      extraction("r1", {
        sentiment: 7,
        aspects: [
          { aspect: "food", sentiment: 2, quote: "cacio e pepe was superb" },
          { aspect: "service", sentiment: -2, quote: "staff ignored us" },
        ],
        dishes: [
          { name: "Cacio e Pepe", normalized: "Cacio e Pepe", sentiment: 2, quote: "" },
          { name: " ", normalized: "", sentiment: 0, quote: "" },
        ],
        vibes: ["cozy", "cozy"],
        practical: { reservation_advised: true, wait_minutes: null, cash_only: null },
      }),
      r,
      { sourcePlaceKey: "k", classifier: "c", promptVersion: "v", analysedAt: NOW },
    );
    expect(a.sentiment).toBe(2);
    expect(a.aspects.map((x) => x.quote)).toEqual(["cacio e pepe was superb", undefined]);
    expect(a.dishes).toEqual([
      { name: "Cacio e Pepe", normalized: "cacio e pepe", sentiment: 2, quote: undefined },
    ]);
    expect(a.vibes).toEqual(["cozy"]);
    expect(a.practical).toEqual({
      reservationAdvised: true,
      waitMinutes: undefined,
      cashOnly: undefined,
    });
    expect(a.contentHash).toBe("h-r1");
  });

  it("keeps only known review ids in summary claims", () => {
    const s = toSummary(
      {
        summary: " Good pasta. ",
        claims: [{ text: "Good pasta.", review_ids: ["a", "zzz", "a"] }],
      },
      new Set(["a"]),
      "c",
      NOW,
    );
    expect(s).toEqual({
      text: "Good pasta.",
      claims: [{ text: "Good pasta.", reviewIds: ["a"] }],
      classifier: "c",
      createdAt: NOW,
    });
  });
});

describe("Jev", () => {
  it("asks one question per vocabulary entry", () => {
    const q = jevQuestions();
    expect(q.useful?.type).toBe("noul");
    expect(q.aspect_food?.type).toBe("choice");
    expect(Object.keys(q).filter((k) => k.startsWith("vibe_"))).toHaveLength(11);
  });

  it("maps answers onto the extraction shape", () => {
    const x = fromJevAnswers("r1", {
      useful: { type: "noul", noul: 0.97 },
      sentiment: { type: "score", score: 3.6 },
      price: { type: "choice", choice: "pricey" },
      aspect_food: { type: "choice", choice: "very_positive" },
      aspect_service: { type: "choice", choice: "not_mentioned" },
      vibe_cozy: { type: "noul", noul: 0.8 },
      vibe_loud: { type: "noul", noul: 0.55 },
      dietary_vegan: { type: "choice", choice: "poorly" },
      flag_rude_staff: { type: "noul", noul: 0.9 },
    });
    expect(x.useful).toBe(true);
    expect(x.sentiment).toBe(2);
    expect(x.price?.signal).toBe("pricey");
    expect(x.aspects).toEqual([{ aspect: "food", sentiment: 2, quote: "" }]);
    expect(x.vibes).toEqual(["cozy"]);
    expect(x.dietary).toEqual([{ tag: "vegan", served: "poorly" }]);
    expect(x.red_flags).toEqual([{ flag: "rude_staff", quote: "" }]);
    expect(x.dishes).toEqual([]);
  });

  it("posts one request per review and surfaces errors", async () => {
    const calls: { url: string; body: { model: string; state: unknown } }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ answers: { useful: { type: "noul", noul: 0.9 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const jev = new TypesafeClassifier({ apiKey: "k", fetch: fakeFetch });
    const out = await jev.classify([review("a", "nice"), review("b", "bad")]);
    expect(out.map((o) => o.id)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.model).toBe("jev-latest");

    const failing = new TypesafeClassifier({
      apiKey: "k",
      fetch: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(failing.classify([review("a", "x")])).rejects.toMatchObject({ retryable: true });
  });
});

describe("Codex", () => {
  it("runs codex exec with a schema and reads the last message", async () => {
    let seen: string[] = [];
    const run: Runner = async (_cmd, args) => {
      seen = args;
      const out = args[args.indexOf("--output-last-message") + 1]!;
      const schema = JSON.parse(await readFile(args[args.indexOf("--output-schema") + 1]!, "utf8"));
      expect(schema.$schema).toBeUndefined();
      expect(schema.additionalProperties).toBe(false);
      await writeFile(out, JSON.stringify({ reviews: [extraction("a")] }));
      return { code: 0, stderr: "" };
    };
    const c = new CodexClassifier({ run, model: "luna" });
    const res = await c.classify([review("a", "great")], {});
    expect(res[0]?.id).toBe("a");
    expect(seen).toEqual(
      expect.arrayContaining(["exec", "--model", "luna", "--sandbox", "read-only"]),
    );
    expect(c.id).toBe("codex:luna");
  });

  it("reports a failed run", async () => {
    const c = new CodexClassifier({ run: async () => ({ code: 1, stderr: "not logged in" }) });
    await expect(c.classify([review("a", "x")], {})).rejects.toThrow(/not logged in/);
  });
});

describe("Anthropic", () => {
  it("sends the cached system prompt with structured output and low effort", async () => {
    let params: Record<string, unknown> = {};
    const client = {
      messages: {
        parse: async (p: Record<string, unknown>) => {
          params = p;
          return { stop_reason: "end_turn", parsed_output: { reviews: [extraction("a")] } };
        },
      },
    } as unknown as ConstructorParameters<typeof AnthropicClassifier>[0] extends infer O
      ? O extends { client?: infer C }
        ? C
        : never
      : never;
    const c = new AnthropicClassifier({ client });
    const out = await c.classify([review("a", "great")], { placeName: "Tasca" });
    expect(out[0]?.id).toBe("a");
    expect(params.model).toBe("claude-haiku-5-5");
    expect((params.output_config as { effort: string }).effort).toBe("low");
    expect(JSON.stringify(params.system)).toContain("ephemeral");
    expect(JSON.stringify(params.messages)).toContain("Place: Tasca");
  });

  it("treats a refusal as an error", async () => {
    const client = {
      messages: { parse: async () => ({ stop_reason: "refusal", parsed_output: null }) },
    };
    const c = new AnthropicClassifier({ client: client as never });
    await expect(c.classify([review("a", "x")], {})).rejects.toBeInstanceOf(ClassifierError);
  });
});

describe("analysePlace", () => {
  const hash = (id: string) =>
    id
      .padEnd(64, "0")
      .replace(/[^0-9a-f]/g, "f")
      .slice(0, 64);
  /** Harvest-schema rows (packages/schemas/src/harvest.ts), plus one malformed line. */
  async function folderWith(ids: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "placemarks-test-"));
    await writeFile(
      join(dir, "place.json"),
      JSON.stringify({
        sourcePlaceKey: "0x1:0x2",
        name: "Tasca",
        lat: 38.7,
        lng: -9.1,
        types: [],
        provider: "gosom",
        fetchedAt: NOW,
      }),
    );
    const rows = ids.map((id) => ({
      id,
      sourcePlaceKey: "0x1:0x2",
      source: "google",
      sourceReviewId: id,
      text: `text ${id}`,
      provider: "gosom",
      fetchedAt: NOW,
      contentHash: hash(id),
    }));
    await writeFile(
      join(dir, "reviews.jsonl"),
      [...rows.map((r) => JSON.stringify(r)), '{"id":"broken"}'].join("\n"),
    );
    return dir;
  }

  function fake(): ReviewClassifier & { calls: number } {
    return {
      id: "fake:model",
      chunkSize: 2,
      calls: 0,
      async classify(reviews) {
        this.calls++;
        // Drops one id on purpose when asked about "skip".
        return reviews
          .filter((r) => r.id !== "skip")
          .map((r) => extraction(r.id, { vibes: ["cozy"] }));
      },
      async summarise() {
        return { summary: "Cozy.", claims: [{ text: "Cozy.", review_ids: ["a"] }] };
      },
    };
  }

  it("analyses new reviews, writes analyses and profiles, and skips up-to-date ones next run", async () => {
    const dir = await folderWith(["a", "b", "c", "skip"]);
    const logs: string[] = [];
    const folder = (await loadPlaceFolder(dir, (m) => logs.push(m)))!;
    expect(folder.name).toBe("Tasca");
    expect(folder.reviews).toHaveLength(4);
    expect(logs.join()).toMatch(/skipped 1 review row/);
    const c = fake();
    const first = await analysePlace(folder, c, { now: () => NOW });
    expect(first.analysed).toBe(3);
    expect(first.failed).toBe(1);
    expect(c.calls).toBe(2);
    expect(first.profile.tags).toEqual([{ kind: "vibe", tag: "cozy", mentions: 3 }]);
    expect(first.profile.summary?.text).toBe("Cozy.");

    const lines = (await readFile(join(dir, "analyses.fake_model.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[0]!) as ReviewAnalysis).promptVersion).toBe(PROMPT_VERSION);
    const profile = JSON.parse(await readFile(join(dir, "profile.json"), "utf8"));
    expect(profile.sourcePlaceKey).toBe("0x1:0x2");

    const again = await analysePlace(folder, c, { now: () => NOW });
    expect(again.analysed).toBe(0);
    expect(again.skipped).toBe(3);
    expect(c.calls).toBe(3); // only the dropped review is retried
    expect(again.profile.summary?.text).toBe("Cozy.");
  });

  it("leaves profiles untouched when every call fails", async () => {
    const dir = await folderWith(["a"]);
    const failing: ReviewClassifier = {
      id: "broken:model",
      chunkSize: 5,
      classify: async () => {
        throw new ClassifierError("model not supported");
      },
    };
    const r = await analysePlace((await loadPlaceFolder(dir))!, failing, { now: () => NOW });
    expect(r.failed).toBe(1);
    await expect(readFile(join(dir, "profile.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(dir, "profile.broken_model.json"), "utf8")).rejects.toThrow();
  });

  it("does not write profile.json for comparison runs", async () => {
    const dir = await folderWith(["a"]);
    await analysePlace((await loadPlaceFolder(dir))!, fake(), {
      now: () => NOW,
      writeDefaultProfile: false,
    });
    await expect(readFile(join(dir, "profile.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(dir, "profile.fake_model.json"), "utf8")).resolves.toContain(
      "0x1:0x2",
    );
  });
});

describe("compare", () => {
  const meta = { sourcePlaceKey: "k", promptVersion: "v", analysedAt: NOW };
  it("scores agreement and lists disagreements", () => {
    const r1 = review("1", "great food, cozy");
    const r2 = review("2", "awful");
    const left = [
      toAnalysis(
        extraction("1", {
          vibes: ["cozy"],
          aspects: [{ aspect: "food", sentiment: 2, quote: "" }],
        }),
        r1,
        { ...meta, classifier: "A" },
      ),
      toAnalysis(extraction("2", { sentiment: -2 }), r2, { ...meta, classifier: "A" }),
    ];
    const right = [
      toAnalysis(
        extraction("1", {
          vibes: ["cozy"],
          aspects: [{ aspect: "food", sentiment: 2, quote: "" }],
        }),
        r1,
        { ...meta, classifier: "B" },
      ),
      toAnalysis(extraction("2", { sentiment: 2, useful: false }), r2, {
        ...meta,
        classifier: "B",
      }),
    ];
    const ag = compareAnalyses(left, right);
    expect(ag.shared).toBe(2);
    expect(ag.useful).toBe(0.5);
    expect(ag.aspectSentiment).toBe(1);
    expect(ag.disagreements).toEqual([{ reviewId: "2", fields: ["useful", "sentimentWithinOne"] }]);
    expect(formatAgreement(ag)).toContain("| A vs B | |");
    const none = compareAnalyses([], [], { a: "codex:x", b: "codex:y" });
    expect(formatAgreement(none)).toMatch(/^codex:x vs codex:y: no reviews analysed by both/);
  });
});
