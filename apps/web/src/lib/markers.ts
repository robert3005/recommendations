/**
 * List marker palette (book/src/map-view.md): every list carries a user-selected
 * marker colour; its places' pins wear it on the map.
 */
import type { List } from "@placemarks/domain";

export const MARKER_COLORS = [
  "#dc2626", // red
  "#2563eb", // blue
  "#059669", // emerald
  "#7c3aed", // violet
  "#db2777", // pink
  "#0d9488", // teal
  "#4f46e5", // indigo
  "#65a30d", // lime
] as const;

/** Default pin colour for saves that belong to no list. */
export const DEFAULT_PIN_COLOR = "#be123c";
/** Manual unlinked pins keep their distinct colour. */
export const UNLINKED_PIN_COLOR = "#b45309";
/** A place in several lists renders neutral (deterministic, per the book). */
export const MULTI_LIST_PIN_COLOR = "#1c1917";

/** Suggest the first palette colour not yet used by an existing list. */
export function nextUnusedColor(lists: Pick<List, "color">[]): string {
  const used = new Set(lists.map((l) => l.color).filter(Boolean));
  return MARKER_COLORS.find((c) => !used.has(c)) ?? MARKER_COLORS[0];
}

/** The pin colour for a place given the lists containing it. */
export function pinColorForLists(memberLists: Pick<List, "color">[]): string {
  if (memberLists.length === 1) return memberLists[0]?.color ?? DEFAULT_PIN_COLOR;
  if (memberLists.length > 1) return MULTI_LIST_PIN_COLOR;
  return DEFAULT_PIN_COLOR;
}
