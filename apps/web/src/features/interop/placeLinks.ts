/**
 * Map links, both directions.
 *
 * **In:** a pasted Google Maps, OpenStreetMap or Apple Maps URL becomes a typed
 * result. This is the answer to "OSM search quality trails Google's" that does
 * not require a Google API — someone sends you a link, and we keep the place.
 * An OSM link is the best case by a distance: it can name an actual element, so
 * the place resolves with real evidence rather than bare coordinates.
 *
 * **Out:** the same three providers as deep links. Placemarks curates; navigation
 * happens in whichever app the reader already uses.
 *
 * Everything here is pure string work — no fetch, no DOM.
 */
import type { OsmElementRef } from "@placemarks/domain";
import { googleFeatureId, googleUrlCoords, isGoogleMapsUrl, osmRefFromUrl } from "./googleUrl";

export type LinkProvider = "google-maps" | "openstreetmap" | "apple-maps";

export interface ParsedPlaceLink {
  provider: LinkProvider;
  /** The URL as pasted — retained as provenance and as the deep link back. */
  url: string;
  /** Present when the link names a real OSM element: resolve it for true evidence. */
  osmRef?: OsmElementRef;
  coords?: { lat: number; lng: number };
  name?: string;
  /** Google's opaque listing id — a dedup key, never fetched. */
  fid?: string;
  /**
   * A shortened share link. The browser cannot follow the redirect (no CORS),
   * so the UI asks for the expanded URL rather than failing silently.
   */
  needsExpansion?: boolean;
}

const APPLE_HOSTS = /^(maps\.apple\.com|beta\.maps\.apple\.com)$/;
const OSM_HOSTS = /(^|\.)openstreetmap\.org$/;

function validCoords(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}

function coordsFrom(lat: string | undefined, lng: string | undefined) {
  if (!lat || !lng) return undefined;
  const parsedLat = Number.parseFloat(lat);
  const parsedLng = Number.parseFloat(lng);
  return validCoords(parsedLat, parsedLng) ? { lat: parsedLat, lng: parsedLng } : undefined;
}

/**
 * Google's place URLs carry the camera centre in `@lat,lng,zoom` and the pin's
 * own position in `!3d<lat>!4d<lng>`. The latter is the place; the former is
 * wherever the map happened to be, so it is only a fallback.
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
    if (!decoded || /^-?\d{1,3}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function parseOsm(parsed: URL, url: string): ParsedPlaceLink {
  const osmRef = osmRefFromUrl(url);
  // A marker link (`?mlat=&mlon=`) or the map hash (`#map=zoom/lat/lon`).
  const marker = coordsFrom(
    parsed.searchParams.get("mlat") ?? undefined,
    parsed.searchParams.get("mlon") ?? undefined,
  );
  const hash = parsed.hash.match(/map=[\d.]+\/(-?\d{1,3}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/);
  const coords = marker ?? coordsFrom(hash?.[1], hash?.[2]);
  return {
    provider: "openstreetmap",
    url,
    ...(osmRef ? { osmRef } : {}),
    ...(coords ? { coords } : {}),
  };
}

function parseApple(parsed: URL, url: string): ParsedPlaceLink {
  const ll = parsed.searchParams.get("ll") ?? parsed.searchParams.get("sll");
  const [lat, lng] = (ll ?? "").split(",");
  const coords = coordsFrom(lat, lng);
  // Apple puts either a search term or a coordinate pair in `q`.
  const q = parsed.searchParams.get("q")?.trim();
  const name =
    q && !/^-?\d{1,3}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/.test(q)
      ? q
      : (parsed.searchParams.get("address")?.trim() ?? undefined);
  return {
    provider: "apple-maps",
    url,
    ...(coords ? { coords } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * Parse a pasted map URL. Returns undefined for anything that is not one of the
 * three providers, so the caller can treat the input as a search query instead.
 */
export function parsePlaceLink(raw: string): ParsedPlaceLink | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;

  if (OSM_HOSTS.test(parsed.hostname)) return parseOsm(parsed, trimmed);
  if (APPLE_HOSTS.test(parsed.hostname)) return parseApple(parsed, trimmed);
  if (isGoogleMapsUrl(trimmed)) {
    // A share-sheet short link carries nothing until it is followed, and the
    // browser cannot follow it cross-origin.
    if (parsed.hostname === "maps.app.goo.gl" || parsed.hostname === "goo.gl") {
      return { provider: "google-maps", url: trimmed, needsExpansion: true };
    }
    const coords = googleCoords(trimmed);
    const name = googleName(parsed.pathname);
    const fid = googleFeatureId(trimmed);
    return {
      provider: "google-maps",
      url: trimmed,
      ...(coords ? { coords } : {}),
      ...(name ? { name } : {}),
      ...(fid ? { fid } : {}),
    };
  }
  return undefined;
}

/** A pasted link is usable once it can place a pin, or name an element we can resolve. */
export function linkIsActionable(link: ParsedPlaceLink): boolean {
  return link.osmRef !== undefined || link.coords !== undefined;
}

// ---------- outbound ----------

export interface PlaceLinkTargets {
  google: string;
  apple: string;
  /** Only when the place is bound to an OSM element — a coordinate has no portal page. */
  osm?: string;
}

const GOOGLE_HOSTS = /^((www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?|maps\.app\.goo\.gl)$/;

/** Only a genuine https Google Maps host may be opened from a stored URL. */
function safeGoogleUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && GOOGLE_HOSTS.test(parsed.hostname)) return url;
  } catch {
    // fall through to the search fallback
  }
  return undefined;
}

/**
 * Deep links for a place. A retained Google URL reopens the exact listing;
 * otherwise every provider gets a coordinate/name search, which always works.
 */
export function placeLinksFor(input: {
  lat: number;
  lng: number;
  name?: string;
  /** The retained external-ref URL, when the place was imported or pasted. */
  externalUrl?: string;
  osmRef?: OsmElementRef;
}): PlaceLinkTargets {
  const { lat, lng, name, externalUrl, osmRef } = input;
  const query = `${name ? `${name} ` : ""}${lat},${lng}`;
  return {
    google:
      safeGoogleUrl(externalUrl) ??
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    apple: `https://maps.apple.com/?ll=${lat},${lng}${name ? `&q=${encodeURIComponent(name)}` : ""}`,
    ...(osmRef ? { osm: `https://www.openstreetmap.org/${osmRef.type}/${osmRef.id}` } : {}),
  };
}
