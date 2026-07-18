import type { ResolutionState } from "@placemarks/domain";

const STATES: Record<ResolutionState, { label: string; className: string; title: string }> = {
  resolved: {
    label: "Up to date",
    className: "bg-emerald-100 text-emerald-800",
    title: "Successfully resolved against OpenStreetMap",
  },
  stale: {
    label: "Stale",
    className: "bg-amber-100 text-amber-800",
    title: "Shown from saved OSM data; refresh has not completed",
  },
  unavailable: {
    label: "OSM unreachable",
    className: "bg-stone-200 text-stone-700",
    title: "Provider failure — showing saved data; this is not evidence the place is gone",
  },
  missing: {
    label: "Missing from OSM",
    className: "bg-red-100 text-red-800",
    title: "The OSM element disappeared and no replacement was found",
  },
  "needs-review": {
    label: "Needs review",
    className: "bg-violet-100 text-violet-800",
    title: "The OSM link changed ambiguously — confirm the right place",
  },
  unlinked: {
    label: "Not linked to OSM",
    className: "bg-orange-100 text-orange-800",
    title: "A manual pin with owner-provided details",
  },
};

export function StateBadge({ state }: { state: ResolutionState }) {
  const meta = STATES[state];
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
      title={meta.title}
      data-testid="state-badge"
      data-state={state}
    >
      {meta.label}
    </span>
  );
}
