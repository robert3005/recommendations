/**
 * Conservative evidence-based candidate matching for identity recovery.
 * Scoring order per book/src/place-identity.md §"Search using durable evidence":
 * stable external ids → website/phone → name+address → category+distance.
 * Distance alone can never establish identity.
 */
import { distanceMeters } from "./geo";
import type { OsmEvidence, Place } from "./place";
import { normalizePhone, type ResolvedPoi } from "./poi";

export interface CandidateScore {
  candidate: ResolvedPoi;
  score: number;
  /** True when at least one non-geometric identity signal matched. */
  hasIdentitySignal: boolean;
  reasons: string[];
}

export function normalizeName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return normalized === "" ? undefined : normalized;
}

function websiteHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

const STRONG_ID_KEYS = ["wikidata", "brand:wikidata"];

/** The evidence used for recovery — lastVerified when present, else firstSeen. */
export function recoveryEvidence(place: Place): OsmEvidence | undefined {
  return place.lastVerified ?? place.firstSeen;
}

export function scoreCandidate(evidence: OsmEvidence, candidate: ResolvedPoi): CandidateScore {
  let score = 0;
  let hasIdentitySignal = false;
  const reasons: string[] = [];
  const evTags = evidence.identityTags;
  const candTags = candidate.identityTags;

  for (const key of STRONG_ID_KEYS) {
    if (evTags[key] && evTags[key] === candTags[key]) {
      score += 100;
      hasIdentitySignal = true;
      reasons.push(`strong-id:${key}`);
    }
  }
  for (const key of Object.keys(evTags)) {
    if (key.startsWith("ref:") && evTags[key] === candTags[key]) {
      score += 80;
      hasIdentitySignal = true;
      reasons.push(`strong-id:${key}`);
    }
  }

  const evHost = websiteHost(evidence.website);
  if (evHost && evHost === websiteHost(candidate.website)) {
    score += 40;
    hasIdentitySignal = true;
    reasons.push("website-domain");
  }
  const evPhone = normalizePhone(evidence.phone);
  if (evPhone && evPhone === normalizePhone(candidate.phone)) {
    score += 40;
    hasIdentitySignal = true;
    reasons.push("phone");
  }

  const evName = normalizeName(evidence.name);
  const candName = normalizeName(candidate.name);
  if (evName && evName === candName) {
    score += 30;
    hasIdentitySignal = true;
    reasons.push("name");
  } else if (evTags.brand && evTags.brand === candTags.brand) {
    score += 25;
    hasIdentitySignal = true;
    reasons.push("brand");
  }
  if (
    evTags["addr:street"] &&
    evTags["addr:street"] === candTags["addr:street"] &&
    evTags["addr:housenumber"] === candTags["addr:housenumber"]
  ) {
    score += 15;
    reasons.push("address");
  }

  if (evidence.category === candidate.category) {
    score += 10;
    reasons.push("category");
  }

  const d = distanceMeters(evidence.lat, evidence.lng, candidate.lat, candidate.lng);
  if (d <= 25) {
    score += 10;
    reasons.push("distance<=25m");
  } else if (d <= 100) {
    score += 5;
    reasons.push("distance<=100m");
  } else if (d > 2000) {
    score -= 100;
    reasons.push("distance>2km");
  } else if (d > 500) {
    score -= 20;
    reasons.push("distance>500m");
  }

  return { candidate, score, hasIdentitySignal, reasons };
}

const HIGH_CONFIDENCE_SCORE = 50;
const REVIEW_SCORE = 25;
const REVIEW_LIMIT = 5;

export function isHighConfidence(scored: CandidateScore): boolean {
  // Distance alone can never establish identity — an identity signal is required.
  return scored.score >= HIGH_CONFIDENCE_SCORE && scored.hasIdentitySignal;
}

export type CandidateClassification =
  | { kind: "auto"; best: CandidateScore }
  | { kind: "review"; candidates: CandidateScore[] }
  | { kind: "none" };

/**
 * One unique high-confidence candidate may relink automatically; several require owner
 * review; none (but plausible options) also require review; otherwise recovery fails.
 */
export function classifyCandidates(
  evidence: OsmEvidence,
  candidates: ResolvedPoi[],
): CandidateClassification {
  const scored = candidates
    .map((candidate) => scoreCandidate(evidence, candidate))
    .sort((a, b) => b.score - a.score);
  const high = scored.filter(isHighConfidence);
  if (high.length === 1) return { kind: "auto", best: high[0] as CandidateScore };
  if (high.length > 1) return { kind: "review", candidates: high };
  const plausible = scored.filter((s) => s.score >= REVIEW_SCORE).slice(0, REVIEW_LIMIT);
  if (plausible.length > 0) return { kind: "review", candidates: plausible };
  return { kind: "none" };
}
