/**
 * The place fact block, shared by the place card and the published viewers
 * (spec/src/map-view.md §The place card): the description paragraph — with a
 * small "Wikipedia" credit link (CC BY-SA) when the text came from Wikipedia —
 * then the address, then compact fact rows for website, phone, opening hours,
 * and wheelchair access, each rendered only when the fact exists. Pure
 * presentation over plain strings: the card passes its Place, the viewers
 * their PublishedPlace, and this block depends on neither.
 */

const WHEELCHAIR_LABELS: Record<string, string> = {
  yes: "Wheelchair accessible",
  limited: "Partly accessible",
  no: "Not accessible",
};

/**
 * Normalize a website fact to an https link labelled by its hostname
 * (spec/src/map-view.md §The place card). Capture stores https-only values,
 * but older or hand-entered data may lack a scheme; nothing other than https
 * ever renders.
 */
export function websiteLink(raw: string): { href: string; host: string } | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw.replace(/^http:\/\//i, "https://")
    : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return undefined;
    return { href: url.toString(), host: url.hostname };
  } catch {
    return undefined;
  }
}

export function PlaceFacts({
  description,
  wikipediaUrl,
  creditWikipedia = true,
  address,
  website,
  phone,
  openingHours,
  wheelchair,
}: {
  description?: string;
  /** The source article — the "Wikipedia" credit's target. */
  wikipediaUrl?: string;
  /**
   * Whether a Wikipedia-linked description is credited to Wikipedia. The
   * place card knows `descriptionSource`; the published viewers don't (the
   * wire format omits it), so they credit whenever the article link
   * travelled — over-crediting is the safe side of CC BY-SA.
   */
  creditWikipedia?: boolean;
  address?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  wheelchair?: string;
}) {
  const site = website === undefined ? undefined : websiteLink(website);
  const access = wheelchair === undefined ? undefined : WHEELCHAIR_LABELS[wheelchair];
  const hasRows =
    site !== undefined || phone !== undefined || openingHours !== undefined || access !== undefined;
  return (
    <>
      {description !== undefined ? (
        <p className="mt-2 text-sm leading-relaxed text-ink/85" data-testid="place-description">
          {description}
          {creditWikipedia && wikipediaUrl !== undefined ? (
            <>
              {" "}
              <a
                href={wikipediaUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Text from Wikipedia, licensed CC BY-SA"
                className="text-[11px] whitespace-nowrap text-ink/60 underline"
                data-testid="place-description-credit"
              >
                Wikipedia
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {address !== undefined ? (
        <p className="mt-2 text-sm text-ink/70" data-testid="place-address">
          {address}
        </p>
      ) : null}
      {hasRows ? (
        <div className="mt-2 space-y-1" data-testid="place-facts">
          {site !== undefined ? (
            <p className="text-sm" data-testid="place-website">
              <a
                href={site.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink underline"
              >
                {site.host}
              </a>
            </p>
          ) : null}
          {phone !== undefined ? (
            <p className="text-sm" data-testid="place-phone">
              <a href={`tel:${phone.replace(/[^+\d]/g, "")}`} className="text-ink underline">
                {phone}
              </a>
            </p>
          ) : null}
          {openingHours !== undefined ? (
            <p className="font-mono text-xs text-ink/70" data-testid="place-opening-hours">
              {openingHours}
            </p>
          ) : null}
          {access !== undefined ? (
            <p className="text-xs text-ink/70" data-testid="place-wheelchair">
              {access}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
