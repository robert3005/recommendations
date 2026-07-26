/**
 * Deep links out (spec/src/map-view.md §The place card): Placemarks curates;
 * navigation happens in the tools people prefer. All three URLs come from the
 * one domain deep-link module, so the place card, the exports, and the public
 * viewer hand out the same links (spec/src/architecture.md).
 */
import type { Place } from "@placemarks/domain";
import { appleLink, googleLink, osmLink } from "@placemarks/domain";

export type NavLinksPlace = Pick<
  Place,
  "name" | "lat" | "lng" | "googleUrl" | "appleUrl" | "osmRef"
>;

const linkClass = "text-[11px] text-ink/60 underline hover:text-ink";

export function NavLinks({ place }: { place: NavLinksPlace }) {
  return (
    <>
      <a
        href={googleLink(place)}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-testid="open-google-maps"
      >
        Open in Google Maps
      </a>
      <a
        href={appleLink(place)}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-testid="open-apple-maps"
      >
        Open in Apple Maps
      </a>
      {/* The OSM element page is also where fact corrections happen —
          upstream, never here (spec/src/interop.md §Licensing). */}
      {place.osmRef ? (
        <a
          href={osmLink(place)}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          data-testid="osm-link"
        >
          View on OpenStreetMap
        </a>
      ) : null}
    </>
  );
}
