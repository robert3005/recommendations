/**
 * The public viewer's canvas projection (spec/src/map-view.md §The grammar):
 * `/l/:slug` and `/p/:slug` project the published places — the same grammar,
 * read-only chrome. The document is self-contained, so the pins are explicit;
 * selection rides the app-wide selection store like every other route.
 */
import type { ListMarker } from "@placemarks/domain";
import type { PublishedPlace } from "@placemarks/schemas";
import { useCanvasProjection } from "../../state/projection";

export function usePublishedDocProjection(
  docKey: string,
  places: readonly PublishedPlace[],
  marker?: ListMarker,
): void {
  useCanvasProjection({
    kind: "published-doc",
    docKey,
    places: places.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng })),
    ...(marker !== undefined ? { marker } : {}),
  });
}

/** Clear the canvas while a public document is loading or unavailable. */
export function EmptyPublishedDocProjection({ docKey }: { docKey: string }) {
  usePublishedDocProjection(docKey, []);
  return null;
}
