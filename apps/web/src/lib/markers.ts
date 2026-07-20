/**
 * List marker helpers for the web client (spec/src/map-view.md): every list
 * carries a unique (colour, icon) marker; its places' pins wear it on the
 * canvas. The palette, icon set, and assignment rules live in the domain
 * package — this module re-exports them and adds rendering helpers.
 */
import type { List, ListMarker } from "@placemarks/domain";
import { markerAt, nextUnusedMarker } from "@placemarks/domain";

export type { ListMarker, MarkerIcon } from "@placemarks/domain";
export {
  MARKER_COLORS,
  MARKER_ICONS,
  markerAt,
  markerKey,
  nextUnusedMarker,
  sameMarker,
} from "@placemarks/domain";

/** Default pin colour for transient (not-yet-saved) selections. */
export const DEFAULT_PIN_COLOR = "#be123c";
/**
 * A place in several lists renders the deterministic stacked/badged variant in
 * this neutral base colour (spec/src/map-view.md §Core interactions).
 */
export const MULTI_LIST_PIN_COLOR = "#1c1917";

/** Suggest the next unused (colour, icon) combination for a new list. */
export function suggestMarker(lists: Pick<List, "marker">[]): ListMarker {
  return nextUnusedMarker(lists.map((l) => l.marker));
}

/** A stable fallback marker for previews before any list exists. */
export const FALLBACK_MARKER: ListMarker = markerAt(0);

/**
 * The marker a place's pin wears given the lists containing it: one list →
 * that list's marker; several → the deterministic stacked/badged variant
 * (rendered by the canvas); none → the default transient look.
 */
export function pinMarkerForLists(
  memberLists: Pick<List, "marker">[],
): { kind: "single"; marker: ListMarker } | { kind: "multi" } | { kind: "none" } {
  if (memberLists.length === 1 && memberLists[0]) {
    return { kind: "single", marker: memberLists[0].marker };
  }
  if (memberLists.length > 1) return { kind: "multi" };
  return { kind: "none" };
}

/** Icon glyph path data (24×24 viewBox) for DOM rendering of marker icons. */
export const MARKER_ICON_PATHS: Record<string, string> = {
  circle: "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z",
  diamond: "M12 3l8 9-8 9-8-9z",
  triangle: "M12 4l9 16H3z",
  square: "M5 5h14v14H5z",
  star: "M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L12 16.9 6.4 20l1.4-6.2L3 9.5l6.4-.6z",
  heart: "M12 20.5l-7.1-7.2a4.6 4.6 0 0 1 6.5-6.5l.6.6.6-.6a4.6 4.6 0 0 1 6.5 6.5z",
  flag: "M6 3v18h2v-7h10l-2.5-4L18 6H8V3z",
  drop: "M12 3s6 6.6 6 11a6 6 0 1 1-12 0c0-4.4 6-11 6-11z",
};
