import type { ResolutionState } from "@placemarks/domain";

/**
 * The only state a place advertises is "not linked to OSM" (manual pins).
 * Freshness/recovery badges (stale, unavailable, missing, needs-review) are
 * deferred along with the freshness UI (spec/src/map-view.md); a healthy place
 * shows no marker at all.
 */
export function StateBadge({ state }: { state: ResolutionState }) {
  if (state !== "unlinked") return null;
  return (
    <span
      className="inline-block rounded-full bg-amber-wash px-2 py-0.5 text-xs font-medium text-orange-800"
      title="A manual pin with owner-provided details"
      data-testid="state-badge"
      data-state="unlinked"
    >
      Not linked to OSM
    </span>
  );
}
