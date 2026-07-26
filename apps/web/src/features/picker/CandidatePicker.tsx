/**
 * The import review queue's candidate picker (spec/src/interop.md §The review
 * queue): the item under review lists its persisted geocoder candidates,
 * lettered to match the labelled pins on the canvas. Picking one places the
 * row with that result's facts and records its osmRef — geocoder results are
 * OSM data. Manual placement is clicking the map; skipping stays in the report.
 */
import type { GeocoderCandidate } from "@placemarks/domain";
import { distanceMeters } from "@placemarks/domain";
import { useEffect, useRef } from "react";

export interface CandidatePickerProps {
  /** The row under review, for the heading. */
  title: string;
  /** Persisted geocoder candidates (ImportItem.candidates), in stored order. */
  candidates: GeocoderCandidate[];
  /** The row's own coordinates when it has any — distances render against them. */
  origin?: { lat: number; lng: number };
  onPick: (candidate: GeocoderCandidate) => void;
  onSkip?: () => void;
  onClose: () => void;
}

export function CandidatePicker({
  title,
  candidates,
  origin,
  onPick,
  onSkip,
  onClose,
}: CandidatePickerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Modal focus: enter the sheet on open, return to the invoker on close
  // (spec/src/map-view.md §Accessibility and failure).
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is supplementary; Escape and Cancel are the accessible paths
    <div
      className="absolute inset-0 z-30 flex items-end justify-center bg-ink/30 md:items-center"
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
        aria-label={`Candidates for ${title}`}
        className="max-h-[70%] w-full overflow-y-auto rounded-t-crisp border border-hairline bg-paper p-4 md:w-[28rem] md:rounded-crisp"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        data-testid="candidate-picker"
      >
        <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-ink/60">
          Pick the place you meant — the letters match the pins on the map.
        </p>
        {candidates.length === 0 ? (
          <p className="mt-3 text-sm text-ink" data-testid="no-candidates">
            No geocoder results for this row — place it by clicking the map, or skip it.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-hairline">
            {candidates.map((candidate, index) => (
              <li key={`${index.toString()}-${candidate.lat}-${candidate.lng}`}>
                <button
                  type="button"
                  onClick={() => onPick(candidate)}
                  className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left hover:bg-ink/5"
                  data-testid="candidate-option"
                >
                  <span className="min-w-0">
                    <span className="mr-2 font-mono text-xs text-ink/60">
                      {String.fromCharCode(65 + index)}
                    </span>
                    <span className="text-sm font-medium text-ink">{candidate.name}</span>
                    {candidate.address ? (
                      <span className="block truncate text-xs text-ink/60">
                        {candidate.address}
                      </span>
                    ) : null}
                  </span>
                  {origin ? (
                    <span className="shrink-0 font-mono text-xs text-ink/60">
                      {Math.round(
                        distanceMeters(origin.lat, origin.lng, candidate.lat, candidate.lng),
                      )}{" "}
                      m
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex gap-2 border-t border-hairline pt-3">
          {onSkip ? (
            <button
              type="button"
              onClick={onSkip}
              className="rounded-crisp border border-hairline px-2 py-1 text-xs font-medium text-ink hover:bg-ink/5"
              data-testid="candidate-skip"
            >
              Skip this row
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-crisp px-2 py-1 text-xs font-medium text-ink/60 hover:bg-ink/5"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
