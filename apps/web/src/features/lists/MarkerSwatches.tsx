/**
 * The list marker picker (spec/src/map-view.md: creating a list picks its
 * marker from a swatch row of icon + colour combinations; default: the next
 * unused combination) — one swatch row shared by every surface that creates or
 * re-marks a list. Semantic radios: the sr-only input carries selection state
 * for keyboards, screen readers, and tests.
 */
import type { ListMarker } from "@placemarks/domain";
import { MARKER_COLORS, MARKER_ICONS, markerAt, markerKey, sameMarker } from "../../lib/markers";
import { MarkerGlyph } from "./MarkerGlyph";

export interface MarkerSwatchesProps {
  /** Radio-group name — unique per mounted form. */
  radioName: string;
  selected: ListMarker;
  /** Markers already worn by other live lists — offered combinations skip them. */
  used?: ListMarker[];
  onSelect: (marker: ListMarker) => void;
}

const SWATCH_COUNT = 8;

export function MarkerSwatches({ radioName, selected, used = [], onSelect }: MarkerSwatchesProps) {
  const usedKeys = new Set(used.map(markerKey));
  const options: ListMarker[] = [];
  const seen = new Set<string>();
  const offer = (marker: ListMarker) => {
    const key = markerKey(marker);
    if (seen.has(key)) return;
    seen.add(key);
    options.push(marker);
  };
  // The current selection always stays offered (re-marking keeps it visible).
  offer(selected);
  const total = MARKER_COLORS.length * MARKER_ICONS.length;
  for (let k = 0; k < total && options.length < SWATCH_COUNT; k += 1) {
    const candidate = markerAt(k);
    if (!usedKeys.has(markerKey(candidate))) offer(candidate);
  }
  return (
    <div className="mt-2 flex items-center gap-1.5" role="radiogroup" aria-label="List marker">
      {options.map((option) => {
        const isSelected = sameMarker(option, selected);
        return (
          <label
            key={markerKey(option)}
            className={`inline-flex cursor-pointer items-center justify-center rounded-full border-2 p-0.5 ${
              isSelected ? "border-stone-800" : "border-transparent"
            }`}
          >
            <MarkerGlyph marker={option} size={20} />
            <input
              type="radio"
              name={radioName}
              checked={isSelected}
              onChange={() => onSelect(option)}
              aria-label={`Marker ${option.icon} ${option.color}`}
              className="sr-only"
              data-testid={`marker-${option.color}-${option.icon}`}
            />
          </label>
        );
      })}
    </div>
  );
}
