/**
 * The selected place's card, mounted in the app shell so selection stays
 * visible whatever the notebook shows (spec/src/map-view.md §Selection is
 * bidirectional). Two composers, one card: on mobile a bottom sheet over the
 * canvas (above the notebook sheet); on desktop its own vertical — a
 * full-height column between the notebook and the canvas, present even while
 * the notebook is collapsed. Close → selection clears.
 */
import { useSelectionStore } from "../../state/projection";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

/** Mobile: the bottom sheet, above the notebook sheet (z-40 over z-20). */
export function PlaceSheet() {
  const selectedPlaceId = useSelectionStore((s) => s.selectedPlaceId);
  if (!selectedPlaceId) return null;
  return (
    <PlaceDetailsSheet
      placeId={selectedPlaceId}
      variant="sheet"
      className="absolute inset-x-0 bottom-0 z-40 max-h-[70%] rounded-t-crisp border border-hairline md:hidden"
    />
  );
}

/** Desktop: the place column RootLayout slots into the row after the notebook. */
export function PlaceColumn() {
  const selectedPlaceId = useSelectionStore((s) => s.selectedPlaceId);
  if (!selectedPlaceId) return null;
  return (
    <PlaceDetailsSheet
      placeId={selectedPlaceId}
      variant="column"
      className="relative order-2 hidden h-full w-[26rem] shrink-0 border-r border-hairline md:block md:max-w-[40vw]"
    />
  );
}
