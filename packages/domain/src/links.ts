/**
 * THE one deep-link module (spec/src/interop.md, spec/src/architecture.md §One
 * module for deep links): the place card, every export writer, the public
 * viewer, and the search field all build and parse the same URLs here.
 *
 * Everything is pure string work — a pasted URL is never fetched. Recorded
 * judgements: Google's `!3d`/`!4d` pair (the pin) beats `@lat,lng` (the
 * camera); a coordinate pair sitting in the name slot is not a name; only
 * https Google hosts count as Google links.
 */
import type { OsmRef, Place } from "./entities";
import { osmRefKey } from "./entities";

export type ParsedLink =
  | { kind: "google"; lat?: number; lng?: number; name?: string; featureId?: string; url: string }
  | { kind: "apple"; lat: number; lng: number; name?: string; url: string }
  | { kind: "osm"; ref: OsmRef }
  | { kind: "short-link" } // maps.app.goo.gl — ask for the expanded URL, never fetch
  | undefined;

const GOOGLE_HOSTS = /^((www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?|maps\.app\.goo\.gl)$/;
const SHORT_LINK_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl)$/;
const APPLE_HOSTS = /^(maps\.apple\.com|beta\.maps\.apple\.com)$/;
const OSM_HOSTS = /(^|\.)openstreetmap\.org$/;
const COORD_PAIR = /^-?\d{1,3}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/;

function validCoords(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}

function coordsFrom(
  lat: string | undefined,
  lng: string | undefined,
): { lat: number; lng: number } | undefined {
  if (!lat || !lng) return undefined;
  const parsedLat = Number.parseFloat(lat);
  const parsedLng = Number.parseFloat(lng);
  return validCoords(parsedLat, parsedLng) ? { lat: parsedLat, lng: parsedLng } : undefined;
}

/** The `0x…:0x…` feature-id pair (or `cid=` number) identifying a Google listing — the dedup key. */
export function googleFeatureId(url: string): string | undefined {
  const ftid = url.match(/(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  if (ftid?.[1]) return ftid[1].toLowerCase();
  const cid = url.match(/[?&]cid=(\d+)/);
  if (cid?.[1]) return `cid:${cid[1]}`;
  return undefined;
}

/** Literal coordinates from dropped-pin search URLs (`/maps/search/lat,lng` or `?q=lat,lng`). */
function googleUrlCoords(url: string): { lat: number; lng: number } | undefined {
  // Integer coordinates are legal (dropped pins can carry them verbatim).
  const match =
    url.match(/\/maps\/search\/(-?\d{1,3}(?:\.\d+)?),\s*\+?(-?\d{1,3}(?:\.\d+)?)(?![\d.])/) ??
    url.match(/[?&](?:q|ll|query)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)\s*(-?\d{1,3}(?:\.\d+)?)(?![\d.])/);
  return coordsFrom(match?.[1], match?.[2]);
}

/**
 * Google place URLs carry the camera centre in `@lat,lng,zoom` and the pin's
 * own position in `!3d<lat>!4d<lng>`. The pin is the place; the camera is
 * wherever the map happened to be, so it is only the last resort.
 */
function googleCoords(url: string): { lat: number; lng: number } | undefined {
  const pin = url.match(/!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
  const fromPin = coordsFrom(pin?.[1], pin?.[2]);
  if (fromPin) return fromPin;
  const literal = googleUrlCoords(url);
  if (literal) return literal;
  const camera = url.match(/@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  return coordsFrom(camera?.[1], camera?.[2]);
}

/** `/maps/place/Cervejaria+Ramiro/@…` → "Cervejaria Ramiro". */
function googleName(pathname: string): string | undefined {
  const match = pathname.match(/\/maps\/place\/([^/@]+)/);
  if (!match?.[1]) return undefined;
  try {
    const decoded = decodeURIComponent(match[1].replace(/\+/g, " ")).trim();
    // A coordinate pair in the name slot is a dropped pin, not a name.
    if (!decoded || COORD_PAIR.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function parseOsm(parsed: URL): ParsedLink {
  const match = parsed.pathname.match(/^\/(node|way|relation)\/(\d+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { kind: "osm", ref: { type: match[1] as OsmRef["type"], id: match[2] } };
}

function parseApple(parsed: URL, url: string): ParsedLink {
  const ll = parsed.searchParams.get("ll") ?? parsed.searchParams.get("sll");
  const [lat, lng] = (ll ?? "").split(",");
  const coords = coordsFrom(lat, lng);
  if (!coords) return undefined;
  // Apple puts either a search term or a coordinate pair in `q`.
  const q = parsed.searchParams.get("q")?.trim();
  const name =
    q && !COORD_PAIR.test(q) ? q : parsed.searchParams.get("address")?.trim() || undefined;
  return { kind: "apple", lat: coords.lat, lng: coords.lng, ...(name ? { name } : {}), url };
}

/**
 * Parse a pasted map URL. Returns undefined for anything that is not a Google,
 * Apple, or OSM-element link, so the caller treats the input as a search query.
 */
export function parsePastedLink(input: string): ParsedLink {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;

  if (OSM_HOSTS.test(parsed.hostname)) return parseOsm(parsed);
  if (APPLE_HOSTS.test(parsed.hostname)) return parseApple(parsed, trimmed);

  // Only https Google hosts count as Google links.
  if (parsed.protocol !== "https:") return undefined;
  // A share-sheet short link carries nothing until it is followed, and the
  // browser cannot follow the redirect cross-origin: ask, never fetch.
  if (SHORT_LINK_HOSTS.test(parsed.hostname)) return { kind: "short-link" };
  if (GOOGLE_HOSTS.test(parsed.hostname)) {
    const coords = googleCoords(trimmed);
    const name = googleName(parsed.pathname);
    const featureId = googleFeatureId(trimmed);
    return {
      kind: "google",
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      ...(name ? { name } : {}),
      ...(featureId ? { featureId } : {}),
      url: trimmed,
    };
  }
  return undefined;
}

// ---------- outbound ----------

/** Public OSM page for an element. */
export function osmElementUrl(ref: OsmRef): string {
  return `https://www.openstreetmap.org/${osmRefKey(ref)}`;
}

/** Only a genuine https host may be reopened from a stored URL. */
function safeStoredUrl(url: string | undefined, hosts: RegExp): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && hosts.test(parsed.hostname)) return url;
  } catch {
    // fall through to the search fallback
  }
  return undefined;
}

/**
 * The retained Google URL reopens the exact listing; otherwise a name/coord
 * search URL, which always works.
 */
export function googleLink(p: Pick<Place, "name" | "lat" | "lng" | "googleUrl">): string {
  const stored = safeStoredUrl(p.googleUrl, GOOGLE_HOSTS);
  if (stored) return stored;
  const query = `${p.name ? `${p.name} ` : ""}${p.lat},${p.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** The retained Apple URL, else a `maps.apple.com` coordinate link. */
export function appleLink(p: Pick<Place, "name" | "lat" | "lng" | "appleUrl">): string {
  const stored = safeStoredUrl(p.appleUrl, APPLE_HOSTS);
  if (stored) return stored;
  return `https://maps.apple.com/?ll=${p.lat},${p.lng}${p.name ? `&q=${encodeURIComponent(p.name)}` : ""}`;
}

/** The OSM element page when `osmRef`, else an osm.org `?mlat&mlon` map link. */
export function osmLink(p: Pick<Place, "lat" | "lng" | "osmRef">): string {
  if (p.osmRef) return osmElementUrl(p.osmRef);
  return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}`;
}
