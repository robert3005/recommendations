/**
 * Agreement between two classifiers on the same reviews — the evidence for
 * choosing between Haiku, Jev and Luna. Jev extracts no dishes, so dish
 * agreement is reported only when both sides produced dishes.
 */
import { ASPECTS, type ReviewAnalysis } from "@placemarks/domain";

export interface Agreement {
  a: string;
  b: string;
  shared: number;
  useful: number; // share of reviews where usefulness agrees
  sentimentExact: number;
  sentimentWithinOne: number;
  aspectPresence: number; // mean Jaccard of the aspects each side found
  aspectSentiment: number; // exact agreement on aspects both found
  price: number;
  vibes: number;
  occasions: number;
  dietary: number;
  redFlags: number;
  dishes?: number;
  disagreements: { reviewId: string; fields: string[] }[];
}

function jaccard(x: string[], y: string[]): number {
  const a = new Set(x);
  const b = new Set(y);
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

const mean = (xs: number[]) => (xs.length === 0 ? 1 : xs.reduce((s, x) => s + x, 0) / xs.length);

export function compareAnalyses(left: ReviewAnalysis[], right: ReviewAnalysis[]): Agreement {
  const rightById = new Map(right.map((r) => [r.reviewId, r]));
  const pairs = left.flatMap((l) => {
    const r = rightById.get(l.reviewId);
    return r ? [[l, r] as const] : [];
  });
  const m: Record<string, number[]> = {};
  const push = (k: string, v: number) => {
    m[k] ??= [];
    m[k].push(v);
  };
  const disagreements: Agreement["disagreements"] = [];
  for (const [l, r] of pairs) {
    const fields: string[] = [];
    const check = (k: string, v: number) => {
      push(k, v);
      if (v < 0.5) fields.push(k);
    };
    check("useful", l.useful === r.useful ? 1 : 0);
    check("sentimentWithinOne", Math.abs(l.sentiment - r.sentiment) <= 1 ? 1 : 0);
    push("sentimentExact", l.sentiment === r.sentiment ? 1 : 0);
    check(
      "aspectPresence",
      jaccard(
        l.aspects.map((a) => a.aspect),
        r.aspects.map((a) => a.aspect),
      ),
    );
    for (const aspect of ASPECTS) {
      const la = l.aspects.find((a) => a.aspect === aspect);
      const ra = r.aspects.find((a) => a.aspect === aspect);
      if (la && ra) push("aspectSentiment", la.sentiment === ra.sentiment ? 1 : 0);
    }
    check("price", (l.price?.signal ?? "none") === (r.price?.signal ?? "none") ? 1 : 0);
    check("vibes", jaccard(l.vibes, r.vibes));
    check("occasions", jaccard(l.occasions, r.occasions));
    check(
      "dietary",
      jaccard(
        l.dietary.map((d) => `${d.tag}:${d.served}`),
        r.dietary.map((d) => `${d.tag}:${d.served}`),
      ),
    );
    check(
      "redFlags",
      jaccard(
        l.redFlags.map((f) => f.flag),
        r.redFlags.map((f) => f.flag),
      ),
    );
    if (l.dishes.length > 0 && r.dishes.length > 0) {
      push(
        "dishes",
        jaccard(
          l.dishes.map((d) => d.normalized),
          r.dishes.map((d) => d.normalized),
        ),
      );
    }
    if (fields.length > 0) disagreements.push({ reviewId: l.reviewId, fields });
  }
  disagreements.sort((x, y) => y.fields.length - x.fields.length);
  return {
    a: left[0]?.classifier ?? "a",
    b: right[0]?.classifier ?? "b",
    shared: pairs.length,
    useful: mean(m.useful ?? []),
    sentimentExact: mean(m.sentimentExact ?? []),
    sentimentWithinOne: mean(m.sentimentWithinOne ?? []),
    aspectPresence: mean(m.aspectPresence ?? []),
    aspectSentiment: mean(m.aspectSentiment ?? []),
    price: mean(m.price ?? []),
    vibes: mean(m.vibes ?? []),
    occasions: mean(m.occasions ?? []),
    dietary: mean(m.dietary ?? []),
    redFlags: mean(m.redFlags ?? []),
    dishes: m.dishes ? mean(m.dishes) : undefined,
    disagreements,
  };
}

export function formatAgreement(ag: Agreement): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const rows: [string, string][] = [
    ["Reviews compared", String(ag.shared)],
    ["Useful flag agrees", pct(ag.useful)],
    ["Overall sentiment, exact", pct(ag.sentimentExact)],
    ["Overall sentiment, within one step", pct(ag.sentimentWithinOne)],
    ["Aspects found (Jaccard)", pct(ag.aspectPresence)],
    ["Aspect sentiment, exact (both found)", pct(ag.aspectSentiment)],
    ["Price signal", pct(ag.price)],
    ["Vibes (Jaccard)", pct(ag.vibes)],
    ["Occasions (Jaccard)", pct(ag.occasions)],
    ["Dietary (Jaccard)", pct(ag.dietary)],
    ["Red flags (Jaccard)", pct(ag.redFlags)],
  ];
  if (ag.dishes !== undefined) rows.push(["Dishes (Jaccard)", pct(ag.dishes)]);
  const table = [
    `| ${ag.a} vs ${ag.b} | |`,
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join("\n");
  const worst = ag.disagreements
    .slice(0, 10)
    .map((d) => `- ${d.reviewId}: ${d.fields.join(", ")}`)
    .join("\n");
  return `${table}\n\nMost disagreement:\n${worst || "- none"}\n`;
}
