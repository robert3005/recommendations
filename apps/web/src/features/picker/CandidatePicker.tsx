/**
 * Long-press flow (spec/src/place-identity.md): pick the existing OSM POI, or —
 * when absent — add it upstream, or keep the spot as an unlinked manual pin.
 */
import { distanceMeters, osmEditAtUrl, type ResolvedPoi } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { poiResolver } from "../../providers";

export interface CandidatePickerProps {
  lat: number;
  lng: number;
  onSelect: (poi: ResolvedPoi) => void;
  onClose: () => void;
  /** Wired in Phase 2 — saving a coordinate-only pin. */
  onSaveManual?: (pos: { lat: number; lng: number }) => void;
  /**
   * The OSM-editor handoff. Off for imported places: their coordinates are
   * Google-derived and must never pre-fill an OSM contribution
   * (spec/src/interop.md §Licensing hygiene).
   */
  allowOsmAdd?: boolean;
}

export function CandidatePicker({
  lat,
  lng,
  onSelect,
  onClose,
  onSaveManual,
  allowOsmAdd = true,
}: CandidatePickerProps) {
  const nearbyQuery = useQuery({
    queryKey: ["nearby", lat.toFixed(5), lng.toFixed(5)],
    queryFn: ({ signal }) => poiResolver.searchNearby({ lat, lng, radiusM: 80, signal }),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Modal focus: enter the sheet on open, return to the invoker on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is supplementary; Escape and the Cancel button are the accessible paths
    <div
      className="absolute inset-0 z-30 flex items-end justify-center bg-black/30 md:items-center"
      onClick={onClose}
      onKeyDown={() => {}}
      role="presentation"
      data-testid="candidate-picker-backdrop"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Nearby places on OpenStreetMap"
        className="max-h-[70%] w-full overflow-y-auto rounded-t-2xl bg-paper p-4 shadow-xl md:w-[28rem] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        data-testid="candidate-picker"
      >
        <h2 className="text-base font-semibold text-ink">Nearby on OpenStreetMap</h2>
        <p className="mt-0.5 text-xs text-ink-3">
          Pick the place you meant — saving links it to its OSM record.
        </p>
        {nearbyQuery.isPending ? (
          <p className="mt-3 text-sm text-ink-3">Looking around…</p>
        ) : nearbyQuery.isError ? (
          <div className="mt-3">
            <p className="text-sm text-coral-ink">
              Could not reach OpenStreetMap services. Try again, or use the options below.
            </p>
            <button
              type="button"
              onClick={() => void nearbyQuery.refetch()}
              className="mt-2 rounded border border-rule px-2 py-1 text-xs font-medium text-ink-2 hover:bg-land"
              data-testid="retry-nearby"
            >
              Retry
            </button>
          </div>
        ) : nearbyQuery.data.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2" data-testid="no-candidates">
            Nothing mapped here yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-land">
            {nearbyQuery.data.map((poi) => (
              <li key={`${poi.osmRef.type}/${poi.osmRef.id}`}>
                <button
                  type="button"
                  onClick={() => onSelect(poi)}
                  className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left hover:bg-land"
                >
                  <span>
                    <span className="text-sm font-medium text-ink">{poi.name}</span>
                    <span className="ml-2 text-xs capitalize text-ink-3">{poi.category}</span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-3">
                    {Math.round(distanceMeters(lat, lng, poi.lat, poi.lng))} m
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-land pt-3">
          {allowOsmAdd ? (
            <div className="w-full">
              <a
                href={osmEditAtUrl(lat, lng)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded border border-rule px-2 py-1 text-xs font-medium text-ink-2 hover:bg-land"
              >
                Add it on OpenStreetMap
              </a>
              <p className="mt-1 text-[11px] text-ink-3">
                OSM edits are public and permanent. Check existing places before adding, use only
                verifiable facts you observed yourself — no personal data, and do not copy from
                proprietary maps.
              </p>
            </div>
          ) : null}
          {onSaveManual ? (
            <button
              type="button"
              onClick={() => onSaveManual({ lat, lng })}
              className="rounded border border-orange-300 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-50"
              data-testid="save-manual"
            >
              Save as unlinked pin
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-xs font-medium text-ink-3 hover:bg-land"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
