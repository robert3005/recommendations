/**
 * `#place-<id>` fragments (spec/src/sharing.md §Publish-time link rewrite):
 * published mentions rewrite to these, and the viewer maps them to pin focus.
 * Selection is the app-wide selection store — a pin tap selects the row, a
 * row or mention click selects AND flies — and the fragment follows along
 * without adding history entries.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useSelectionStore } from "../../state/projection";

export function placeFragment(placeId: string): string {
  return `#place-${placeId}`;
}

export function placeIdFromHash(hash: string): string | undefined {
  const match = /^#place-(.+)$/.exec(hash);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * The selected published place, restricted to places that are actually in the
 * document — an unknown fragment selects nothing. The URL fragment is applied
 * on load and on every hash change; `select` writes it back via replaceState
 * (focus is not navigation).
 */
export function usePlaceFragmentSelection(
  placeIds: readonly string[],
): [string | undefined, (placeId: string) => void] {
  const idsKey = placeIds.join(" ");
  const ids = useMemo(() => new Set(idsKey === "" ? [] : idsKey.split(" ")), [idsKey]);
  const selectedPlaceId = useSelectionStore((s) => s.selectedPlaceId);
  const focusPlace = useSelectionStore((s) => s.focusPlace);
  const clearSelection = useSelectionStore((s) => s.clearSelection);

  useEffect(() => {
    const apply = () => {
      const fromHash = placeIdFromHash(window.location.hash);
      if (fromHash !== undefined && ids.has(fromHash)) focusPlace(fromHash);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [ids, focusPlace]);

  // The viewer's selection must not leak into whatever route comes next.
  useEffect(() => clearSelection, [clearSelection]);

  const select = useCallback(
    (placeId: string) => {
      if (!ids.has(placeId)) return;
      focusPlace(placeId);
      window.history.replaceState(null, "", placeFragment(placeId));
    },
    [ids, focusPlace],
  );

  const selected =
    selectedPlaceId !== null && ids.has(selectedPlaceId) ? selectedPlaceId : undefined;
  return [selected, select];
}
