/**
 * The list marker colour picker (book/src/map-view.md: every list carries a
 * user-selected marker its places wear on the map) — one swatch row shared by
 * every surface that creates a list. Semantic radios: the sr-only input carries
 * selection state for keyboards, screen readers, and tests.
 */
import { MARKER_COLORS } from "../../lib/markers";

export interface MarkerSwatchesProps {
  /** Radio-group name — unique per mounted form. */
  radioName: string;
  selected: string;
  onSelect: (color: string) => void;
}

export function MarkerSwatches({ radioName, selected, onSelect }: MarkerSwatchesProps) {
  return (
    <div className="mt-2 flex items-center gap-1.5" role="radiogroup" aria-label="List marker">
      {MARKER_COLORS.map((option) => (
        <label
          key={option}
          className={`inline-block h-5 w-5 cursor-pointer rounded-full border-2 ${
            option === selected ? "border-stone-800" : "border-transparent"
          }`}
          style={{ backgroundColor: option }}
        >
          <input
            type="radio"
            name={radioName}
            checked={option === selected}
            onChange={() => onSelect(option)}
            aria-label={`Marker colour ${option}`}
            className="sr-only"
            data-testid={`marker-${option}`}
          />
        </label>
      ))}
    </div>
  );
}
