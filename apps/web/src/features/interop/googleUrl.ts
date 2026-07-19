/**
 * Google Maps URL forensics (spec/src/interop.md §What we import). Takeout CSVs
 * carry no coordinates — the URL is either a place URL with an opaque feature-id
 * pair (a dedup key and deep link, never fetched) or, for user-dropped pins, a
 * search URL embedding literal `lat,lng`.
 */

/** True when the URL genuinely points at Google Maps (not merely any URL an import carried). */
export function isGoogleMapsUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      /^((www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?|maps\.app\.goo\.gl)$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** An OSM portal URL (our own CSV export emits them) resolves directly — no geocoding. */
export function osmRefFromUrl(
  url: string | undefined,
): { type: "node" | "way" | "relation"; id: string } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)openstreetmap\.org$/.test(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/^\/(node|way|relation)\/(\d+)$/);
    if (!match?.[1] || !match[2]) return undefined;
    return { type: match[1] as "node" | "way" | "relation", id: match[2] };
  } catch {
    return undefined;
  }
}

/** The `0x…:0x…` feature-id pair (or `cid=` number) identifying a Google listing. */
export function googleFeatureId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const ftid = url.match(/(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  if (ftid?.[1]) return ftid[1].toLowerCase();
  const cid = url.match(/[?&]cid=(\d+)/);
  if (cid?.[1]) return `cid:${cid[1]}`;
  return undefined;
}

/** Literal coordinates from dropped-pin search URLs (`/maps/search/lat,lng` or `?q=lat,lng`). */
export function googleUrlCoords(url: string | undefined): { lat: number; lng: number } | undefined {
  if (!url) return undefined;
  // Integer coordinates are legal (our own CSV export emits them verbatim).
  const match =
    url.match(/\/maps\/search\/(-?\d{1,3}(?:\.\d+)?),\s*\+?(-?\d{1,3}(?:\.\d+)?)(?![\d.])/) ??
    url.match(/[?&](?:q|ll|query)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)\s*(-?\d{1,3}(?:\.\d+)?)(?![\d.])/);
  if (!match?.[1] || !match[2]) return undefined;
  const lat = Number.parseFloat(match[1]);
  const lng = Number.parseFloat(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}
