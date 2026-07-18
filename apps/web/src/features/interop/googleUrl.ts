/**
 * Google Maps URL forensics (book/src/interop.md §What we import). Takeout CSVs
 * carry no coordinates — the URL is either a place URL with an opaque feature-id
 * pair (a dedup key and deep link, never fetched) or, for user-dropped pins, a
 * search URL embedding literal `lat,lng`.
 */

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
  const match =
    url.match(/\/maps\/search\/(-?\d{1,3}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/) ??
    url.match(/[?&](?:q|ll|query)=(-?\d{1,3}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/);
  if (!match?.[1] || !match[2]) return undefined;
  const lat = Number.parseFloat(match[1]);
  const lng = Number.parseFloat(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}
