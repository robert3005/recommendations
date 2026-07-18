/**
 * The one OSM affordance on a place: a small link to the element's portal page.
 * In-app edit/report/refresh actions are deferred (book/src/map-view.md) — the
 * portal itself offers editing and issue reporting.
 */
import { type OsmElementRef, osmElementUrl } from "@placemarks/domain";

export function OsmLink({ osmRef }: { osmRef: OsmElementRef }) {
  return (
    <a
      href={osmElementUrl(osmRef)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[11px] text-stone-400 underline hover:text-stone-700"
      data-testid="osm-link"
    >
      View on OpenStreetMap
    </a>
  );
}
