/**
 * The conservative refresh / re-resolution state machine from book/src/place-identity.md.
 * Attaching a person's notes to the wrong business is worse than showing stale data.
 */
import { distanceMeters } from "./geo";
import { classifyCandidates, normalizeName, recoveryEvidence } from "./match";
import { evidenceFromPoi, linkPlaceToOsm, type OsmEvidence, type Place } from "./place";
import type { ResolvedPoi } from "./poi";

/** Outcome of fetching the exact current OSM reference. */
export type ExactOutcome =
  | { type: "ok"; poi: ResolvedPoi }
  | { type: "gone" } // definitive missing/deleted from OSM
  | { type: "error" }; // timeout, offline, rate limit, provider failure

/**
 * Ordinary changes to name/website/hours/phone/address are not a new identity.
 * A radical move combined with incompatible identity fields is possible repurposing.
 */
export function plausiblySameElement(prev: OsmEvidence, next: ResolvedPoi): boolean {
  const moved = distanceMeters(prev.lat, prev.lng, next.lat, next.lng);
  const nameMatches =
    (normalizeName(prev.name) !== undefined &&
      normalizeName(prev.name) === normalizeName(next.name)) ||
    (prev.identityTags.brand !== undefined && prev.identityTags.brand === next.identityTags.brand);
  const categoryCompatible = prev.category === next.category;
  if (moved <= 150) return true;
  if (nameMatches) return true;
  return moved <= 500 && categoryCompatible;
}

export type ExactResolutionResult =
  | { kind: "updated"; place: Place }
  | { kind: "recover"; place: Place }; // definitive disappearance — run candidate recovery

/**
 * Step 1+2 of refresh: resolve the current reference first; distinguish unavailability
 * from disappearance. Provider failure never triggers relinking.
 */
export function applyExactOutcome(
  place: Place,
  outcome: ExactOutcome,
  now: string,
): ExactResolutionResult {
  if (!place.currentOsmRef) {
    // Unlinked manual places are never resolved.
    return { kind: "updated", place };
  }
  if (outcome.type === "error") {
    return {
      kind: "updated",
      place: {
        ...place,
        resolutionState: place.resolutionState === "needs-review" ? "needs-review" : "unavailable",
        lastResolutionAttemptAt: now,
        updatedAt: now,
      },
    };
  }
  if (outcome.type === "gone") {
    return { kind: "recover", place: { ...place, lastResolutionAttemptAt: now, updatedAt: now } };
  }
  const prev = recoveryEvidence(place);
  if (prev && !plausiblySameElement(prev, outcome.poi)) {
    // Possible element repurposing — never accepted silently.
    return {
      kind: "updated",
      place: {
        ...place,
        resolutionState: "needs-review",
        lastResolutionAttemptAt: now,
        updatedAt: now,
      },
    };
  }
  return {
    kind: "updated",
    place: {
      ...place,
      lastVerified: evidenceFromPoi(outcome.poi),
      resolutionState: "resolved",
      lastResolutionAttemptAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Steps 3+4: evidence-based candidate search results applied conservatively.
 * Unique high-confidence → automatic relink; ambiguity → needs-review;
 * nothing plausible → missing, continuing to display lastVerified as explicitly stale.
 */
export function applyRecovery(place: Place, candidates: ResolvedPoi[], now: string): Place {
  // The latest observation first; the immutable first-seen evidence second —
  // it is retained precisely because an in-place upstream edit may have
  // stripped the stable identifiers from the latest observation.
  const sources = [recoveryEvidence(place), place.firstSeen].filter(
    (evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined,
  );
  if (sources.length === 0) {
    return { ...place, resolutionState: "missing", lastResolutionAttemptAt: now, updatedAt: now };
  }
  let sawReview = false;
  for (const evidence of sources) {
    const classification = classifyCandidates(evidence, candidates);
    if (classification.kind === "auto") {
      return linkPlaceToOsm(place, classification.best.candidate, now, "resolver-match");
    }
    if (classification.kind === "review") sawReview = true;
  }
  if (sawReview) {
    return {
      ...place,
      resolutionState: "needs-review",
      lastResolutionAttemptAt: now,
      updatedAt: now,
    };
  }
  return { ...place, resolutionState: "missing", lastResolutionAttemptAt: now, updatedAt: now };
}

/** TTL expiry without a completed refresh is `stale` — never an identity change. */
export function markStale(place: Place, now: string): Place {
  if (place.resolutionState !== "resolved") return place;
  return { ...place, resolutionState: "stale", updatedAt: now };
}
