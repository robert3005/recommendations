/**
 * The marker picker for list edit mode (spec/src/data-model.md §Markers):
 * selection is SHAPE FIRST, THEN COLOUR — a row of the eight shapes, then the
 * chosen shape in each of the eight accents. Manual change swaps within FREE
 * (shape, colour) pairs: taken pairs render disabled, the current selection
 * always stays choosable. Semantic radios: the sr-only inputs carry selection
 * state for keyboards, screen readers, and tests.
 */
import type { ListMarker, MarkerShape } from "@placemarks/domain";
import { ACCENT_COLORS, MARKER_SHAPES, markerKey } from "@placemarks/domain";
import { useState } from "react";
import { MarkerGlyph } from "./MarkerGlyph";

export interface MarkerSwatchesProps {
  /** Radio-group name — unique per mounted form. */
  radioName: string;
  selected: ListMarker;
  /** Markers worn by OTHER live lists — those pairs are disabled. */
  used?: ListMarker[];
  onSelect: (marker: ListMarker) => void;
}

export function MarkerSwatches({ radioName, selected, used = [], onSelect }: MarkerSwatchesProps) {
  const usedKeys = new Set(used.map(markerKey));
  const selectedKey = markerKey(selected);
  const [shape, setShape] = useState<MarkerShape>(selected.shape);

  const isFree = (option: ListMarker) =>
    markerKey(option) === selectedKey || !usedKeys.has(markerKey(option));

  const pickShape = (nextShape: MarkerShape) => {
    setShape(nextShape);
    // Keeping the colour across a shape change is the expected gesture; it
    // applies immediately when that pair is free, else the colour row decides.
    const pair: ListMarker = { shape: nextShape, color: selected.color };
    if (isFree(pair)) onSelect(pair);
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div
        className="flex flex-wrap items-center gap-1"
        role="radiogroup"
        aria-label="Marker shape"
      >
        {MARKER_SHAPES.map((option) => {
          const isShape = option === shape;
          // A shape with every colour taken (selection aside) is not offered.
          const anyFree = ACCENT_COLORS.some((accent) =>
            isFree({ shape: option, color: accent.fill }),
          );
          return (
            <label
              key={option}
              className={`inline-flex items-center justify-center rounded-crisp border p-0.5 ${
                isShape ? "border-ink" : "border-transparent"
              } ${anyFree ? "cursor-pointer" : "cursor-not-allowed opacity-30"}`}
            >
              <MarkerGlyph marker={{ shape: option, color: "var(--color-ink)" }} size={18} />
              <input
                type="radio"
                name={`${radioName}-shape`}
                checked={isShape}
                disabled={!anyFree}
                onChange={() => pickShape(option)}
                aria-label={`Shape ${option}`}
                className="sr-only"
                data-testid={`marker-shape-${option}`}
              />
            </label>
          );
        })}
      </div>
      <div
        className="flex flex-wrap items-center gap-1"
        role="radiogroup"
        aria-label="Marker colour"
      >
        {ACCENT_COLORS.map((accent) => {
          const option: ListMarker = { shape, color: accent.fill };
          const free = isFree(option);
          const isSelected = markerKey(option) === selectedKey;
          return (
            <label
              key={accent.name}
              className={`inline-flex items-center justify-center rounded-crisp border p-0.5 ${
                isSelected ? "border-ink" : "border-transparent"
              } ${free ? "cursor-pointer" : "cursor-not-allowed opacity-30"}`}
            >
              <MarkerGlyph marker={option} size={18} />
              <input
                type="radio"
                name={radioName}
                checked={isSelected}
                disabled={!free}
                onChange={() => onSelect(option)}
                aria-label={`Marker ${shape} ${accent.fill}`}
                className="sr-only"
                data-testid={`marker-${shape}-${accent.fill}`}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
