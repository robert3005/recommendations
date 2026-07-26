/**
 * Navigation handoff (spec/src/interop.md §Navigation handoff): Placemarks
 * curates; navigation happens in the tools people prefer. The retained imported
 * Google URL reopens the exact listing; otherwise a coordinate/name search.
 * Routing itself stays external — a non-goal.
 *
 * The URLs come from `placeLinks`, so the place card, the public share page and
 * the text export all hand out the same links.
 */
import type { OsmElementRef } from "@placemarks/domain";
import { placeLinksFor } from "../interop/placeLinks";

export interface NavLinksProps {
  lat: number;
  lng: number;
  name?: string;
  /** The place's retained external-ref URL, when it was imported or pasted. */
  externalUrl?: string;
  /** Present on an OSM-bound place — adds the portal link. */
  osmRef?: OsmElementRef;
}

export function NavLinks({ lat, lng, name, externalUrl, osmRef }: NavLinksProps) {
  const links = placeLinksFor({
    lat,
    lng,
    ...(name ? { name } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(osmRef ? { osmRef } : {}),
  });
  const linkClass = "text-[11px] text-ink-3 underline hover:text-ink-2";
  return (
    <>
      <a
        href={links.google}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-testid="open-google-maps"
      >
        Open in Google Maps
      </a>
      <a
        href={links.apple}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-testid="open-apple-maps"
      >
        Open in Apple Maps
      </a>
      {links.osm ? (
        <a
          href={links.osm}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          data-testid="open-openstreetmap"
        >
          View on OpenStreetMap
        </a>
      ) : null}
    </>
  );
}
