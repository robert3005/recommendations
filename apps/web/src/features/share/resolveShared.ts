/**
 * Viewer-side resolution (book/src/sharing.md §Public guide viewer): paint from
 * copied evidence immediately, resolve each OSM anchor live, and on a confirmed
 * disappearance attempt a unique high-confidence evidence match — temporarily,
 * never rewriting the author's document. Provider failure is not a missing
 * element; manual anchors are never resolved.
 */
import type { OsmEvidence, PoiResolver, ResolvedPoi } from "@placemarks/domain";
import { classifyCandidates, plausiblySameElement, refKey } from "@placemarks/domain";
import type { SharedPlaceAnchor, SharedPlaceEvidence } from "@placemarks/schemas";

export type SharedResolution =
  | { state: "pending" }
  | { state: "live"; poi: ResolvedPoi }
  | { state: "recovered"; poi: ResolvedPoi }
  | { state: "evidence"; reason: "offline" | "error" }
  | { state: "ambiguous" } // several plausible replacements — honesty over guessing
  | { state: "missing" }
  | { state: "manual" };

export function evidenceFromShared(evidence: SharedPlaceEvidence): OsmEvidence {
  return {
    ref: evidence.osmRef,
    ...(evidence.osmVersion !== undefined ? { osmVersion: evidence.osmVersion } : {}),
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    ...(evidence.name ? { name: evidence.name } : {}),
    category: evidence.category,
    lat: evidence.lat,
    lng: evidence.lng,
    ...(evidence.address ? { address: evidence.address } : {}),
    ...(evidence.website ? { website: evidence.website } : {}),
    ...(evidence.phone ? { phone: evidence.phone } : {}),
    identityTags: evidence.stableIds ?? {},
    observedAt: evidence.observedAt,
  };
}

const RECOVERY_RADIUS_M = 250;

export async function resolveSharedAnchor(
  resolver: PoiResolver,
  anchor: SharedPlaceAnchor,
): Promise<SharedResolution> {
  if (anchor.kind === "manual") return { state: "manual" };
  try {
    const evidence = evidenceFromShared(anchor.lastVerified);
    const outcome = await resolver.resolveExact(anchor.currentOsmRef);
    // A fetched element that is no longer plausibly the same place (redrawn,
    // repurposed) is treated exactly like a disappearance — recovery, never
    // blind acceptance of whatever now wears the old id.
    if (outcome.type === "ok" && plausiblySameElement(evidence, outcome.poi)) {
      return { state: "live", poi: outcome.poi };
    }
    if (outcome.type === "error") return { state: "evidence", reason: "error" };
    // Confirmed gone or incompatible: conservative evidence-based temporary
    // recovery. Both evidence epochs act as ONE decision — search near each
    // distinct copied coordinate, and recover only when the epochs converge on
    // one unique winner. Disagreeing winners are ambiguity, not a guess.
    const epochs = [evidence, evidenceFromShared(anchor.firstSeen)];
    const searched = new Set<string>();
    const candidates: ResolvedPoi[] = [];
    const seenCandidates = new Set<string>();
    for (const source of epochs) {
      const at = `${source.lat.toString()},${source.lng.toString()}`;
      if (searched.has(at)) continue;
      searched.add(at);
      for (const candidate of await resolver.searchNearby({
        lat: source.lat,
        lng: source.lng,
        radiusM: RECOVERY_RADIUS_M,
      })) {
        const key = refKey(candidate.osmRef);
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        candidates.push(candidate);
      }
    }
    const winners = new Map<string, ResolvedPoi>();
    let sawPlausible = false;
    for (const source of epochs) {
      const classified = classifyCandidates(source, candidates);
      if (classified.kind === "auto") {
        winners.set(refKey(classified.best.candidate.osmRef), classified.best.candidate);
      }
      if (classified.kind === "review") sawPlausible = true;
    }
    const unique = winners.size === 1 ? [...winners.values()][0] : undefined;
    if (unique) return { state: "recovered", poi: unique };
    // Plausible-but-ambiguous replacements are not a disappearance verdict.
    return winners.size > 1 || sawPlausible ? { state: "ambiguous" } : { state: "missing" };
  } catch {
    return { state: "evidence", reason: "error" };
  }
}

/** Bounded concurrent resolution across a guide's anchors. */
export async function resolveAllAnchors(
  resolver: PoiResolver,
  anchors: Map<string, SharedPlaceAnchor>,
  onResolution: (blockId: string, resolution: SharedResolution) => void,
  concurrency = 4,
): Promise<void> {
  const entries = [...anchors.entries()];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (index < entries.length) {
      const current = entries[index];
      index += 1;
      if (!current) break;
      const [blockId, anchor] = current;
      onResolution(blockId, await resolveSharedAnchor(resolver, anchor));
    }
  });
  await Promise.all(workers);
}
