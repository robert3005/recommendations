/**
 * Navigation handoff (book/src/interop.md §Navigation handoff): Placemarks
 * curates; navigation happens in the tools people prefer. The retained imported
 * Google URL reopens the exact listing; otherwise a coordinate/name search.
 * Routing itself stays external — a non-goal.
 */
export interface NavLinksProps {
  lat: number;
  lng: number;
  name?: string;
  /** The place's retained external-ref URL, when it was imported. */
  externalUrl?: string;
}

export function NavLinks({ lat, lng, name, externalUrl }: NavLinksProps) {
  const google =
    externalUrl ??
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
  const apple = `https://maps.apple.com/?ll=${lat},${lng}${
    name ? `&q=${encodeURIComponent(name)}` : ""
  }`;
  const linkClass = "text-[11px] text-stone-400 underline hover:text-stone-700";
  return (
    <>
      <a
        href={google}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-testid="open-google-maps"
      >
        Open in Google Maps
      </a>
      <a
        href={apple}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-testid="open-apple-maps"
      >
        Open in Apple Maps
      </a>
    </>
  );
}
