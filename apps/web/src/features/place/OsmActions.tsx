/** Source actions: corrections go upstream to OSM (book/src/map-view.md). */
import { type OsmElementRef, osmEditUrl, osmElementUrl, osmNoteUrl } from "@placemarks/domain";

function ExternalAction({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
    >
      {label}
    </a>
  );
}

export function OsmActions({ osmRef, lat, lng }: { osmRef?: OsmElementRef; lat: number; lng: number }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5" data-testid="osm-actions">
      {osmRef ? (
        <>
          <ExternalAction href={osmElementUrl(osmRef)} label="View on OpenStreetMap" />
          <ExternalAction href={osmEditUrl(osmRef)} label="Edit on OpenStreetMap" />
        </>
      ) : null}
      <ExternalAction href={osmNoteUrl(lat, lng)} label="Report a map issue" />
      <ExternalAction
        href={`https://www.openstreetmap.org/directions?to=${lat.toFixed(5)}%2C${lng.toFixed(5)}`}
        label="Directions"
      />
    </div>
  );
}
