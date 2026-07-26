/**
 * A list marker rendered in the DOM (lists home rows, swatches, toggles):
 * the icon glyph in white on the marker's colour disc — the same look the
 * canvas draws as a sprite (spec/src/map-view.md §Core interactions).
 */
import type { ListMarker } from "@placemarks/domain";
import { MARKER_ICON_PATHS } from "../../lib/markers";

export function MarkerGlyph({
  marker,
  size = 20,
  unlinkedDot = false,
}: {
  marker: ListMarker;
  size?: number;
  /** The small "not linked" dot an unlinked manual pin wears. */
  unlinkedDot?: boolean;
}) {
  const path = MARKER_ICON_PATHS[marker.icon] ?? MARKER_ICON_PATHS.circle;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ backgroundColor: marker.color, width: size, height: size }}
      data-testid="marker-glyph"
      data-color={marker.color}
      data-icon={marker.icon}
    >
      <svg
        viewBox="0 0 24 24"
        width={size * 0.62}
        height={size * 0.62}
        aria-hidden="true"
        focusable="false"
      >
        <path d={path} fill="#fafaf9" />
      </svg>
      {unlinkedDot ? (
        <span
          className="absolute -right-0.5 -top-0.5 block rounded-full border border-white bg-ink-3"
          style={{ width: size * 0.35, height: size * 0.35 }}
          data-testid="unlinked-dot"
        />
      ) : null}
    </span>
  );
}
