/**
 * The selected place's card, mounted in the app shell so selection stays
 * visible whatever the notebook shows (spec/src/map-view.md §Selection is
 * bidirectional). Tap a pin → the card rises; close → selection clears.
 */
import { useSelectionStore } from "../../state/projection";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

export function PlaceSheet() {
  const selectedPlaceId = useSelectionStore((s) => s.selectedPlaceId);
  if (!selectedPlaceId) return null;
  return <PlaceDetailsSheet placeId={selectedPlaceId} />;
}
