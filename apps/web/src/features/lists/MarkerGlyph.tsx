/**
 * A list marker rendered in the DOM (list rows, swatches, place-card chips):
 * one solid accent-coloured shape from MARKER_SHAPE_PATHS — the same path data
 * the canvas draws as pins, so the two renderings can never diverge
 * (spec/src/design.md §Markers). Beyond 64 live lists pairs repeat with a
 * small numeral badge as the deterministic variant.
 */
import type { ListMarker } from "@placemarks/domain";
import { MARKER_SHAPE_PATHS } from "@placemarks/domain";

export function MarkerGlyph({
  marker,
  size = 20,
  badge,
}: {
  marker: ListMarker;
  size?: number;
  /** The repeat numeral a beyond-64 pair wears (spec/src/data-model.md §Markers). */
  badge?: number;
}) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      data-testid="marker-glyph"
      data-shape={marker.shape}
      data-color={marker.color}
    >
      <svg viewBox="0 0 30 30" width={size} height={size} aria-hidden="true" focusable="false">
        <path d={MARKER_SHAPE_PATHS[marker.shape]} fill={marker.color} />
      </svg>
      {badge !== undefined ? (
        <span
          className="absolute -right-1 -top-1 flex items-center justify-center rounded-full border border-paper bg-ink font-mono text-paper"
          style={{ minWidth: size * 0.5, height: size * 0.5, fontSize: size * 0.35 }}
          data-testid="marker-badge"
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
}
