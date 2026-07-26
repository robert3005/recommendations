/**
 * The marker swatch row for list edit mode (spec/src/data-model.md §Markers):
 * manual change swaps within FREE (shape, colour) pairs — every free pair is
 * offered, plus the current selection so re-marking keeps it visible.
 * Semantic radios: the sr-only input carries selection state for keyboards,
 * screen readers, and tests.
 */
import type { ListMarker } from "@placemarks/domain";
import { ACCENT_COLORS, MARKER_SHAPES, markerKey } from "@placemarks/domain";
import { MarkerGlyph } from "./MarkerGlyph";

export interface MarkerSwatchesProps {
  /** Radio-group name — unique per mounted form. */
  radioName: string;
  selected: ListMarker;
  /** Markers worn by OTHER live lists — those pairs are not offered. */
  used?: ListMarker[];
  onSelect: (marker: ListMarker) => void;
}

export function MarkerSwatches({ radioName, selected, used = [], onSelect }: MarkerSwatchesProps) {
  const usedKeys = new Set(used.map(markerKey));
  const selectedKey = markerKey(selected);
  // Colour-major over the full pair space, filtered to free pairs.
  const options: ListMarker[] = [];
  for (const accent of ACCENT_COLORS) {
    for (const shape of MARKER_SHAPES) {
      const option: ListMarker = { shape, color: accent.fill };
      const key = markerKey(option);
      if (key === selectedKey || !usedKeys.has(key)) options.push(option);
    }
  }
  return (
    <div
      className="mt-2 flex max-w-md flex-wrap items-center gap-1"
      role="radiogroup"
      aria-label="List marker"
    >
      {options.map((option) => {
        const isSelected = markerKey(option) === selectedKey;
        return (
          <label
            key={markerKey(option)}
            className={`inline-flex cursor-pointer items-center justify-center rounded-crisp border p-0.5 ${
              isSelected ? "border-ink" : "border-transparent"
            }`}
          >
            <MarkerGlyph marker={option} size={18} />
            <input
              type="radio"
              name={radioName}
              checked={isSelected}
              onChange={() => onSelect(option)}
              aria-label={`Marker ${option.shape} ${option.color}`}
              className="sr-only"
              data-testid={`marker-${option.shape}-${option.color}`}
            />
          </label>
        );
      })}
    </div>
  );
}
