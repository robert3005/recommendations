/**
 * Resolved POI — the transient source view of an OSM element, and the tag-derivation
 * rules from book/src/data-sources.md ("Fields we derive").
 */
import type { OsmElementRef } from "./osm";

export interface ResolvedPoi {
  osmRef: OsmElementRef;
  osmVersion?: number;
  name?: string; // not every OSM feature is named
  category: string; // derived from the primary feature tag
  lat: number;
  lng: number;
  address?: string;
  website?: string; // website → contact:website → url
  phone?: string;
  openingHours?: string;
  socials?: Record<string, string>;
  identityTags: Record<string, string>;
  resolvedAt: string;
}

export const PRIMARY_CATEGORY_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "leisure",
  "office",
  "craft",
] as const;

export function primaryCategory(
  tags: Record<string, string>,
): { key: string; value: string } | undefined {
  for (const key of PRIMARY_CATEGORY_KEYS) {
    const value = tags[key];
    if (value) return { key, value };
  }
  return undefined;
}

export function deriveCategory(tags: Record<string, string>): string {
  return primaryCategory(tags)?.value ?? "place";
}

/**
 * External URLs are untrusted data: only normalized http:/https: destinations are ever
 * rendered as links (book/src/data-model.md).
 */
export function normalizeWebsite(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let candidate = raw.trim();
  if (candidate === "") return undefined;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname.includes(".")) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** website → contact:website → url, first value that normalizes to http(s). */
export function websiteFromTags(tags: Record<string, string>): string | undefined {
  for (const key of ["website", "contact:website", "url"]) {
    const normalized = normalizeWebsite(tags[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

export function phoneFromTags(tags: Record<string, string>): string | undefined {
  return tags.phone ?? tags["contact:phone"];
}

/** Reduce a phone number to digits (plus leading +) for identity matching. */
export function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d+]/g, "");
  const normalized = digits.startsWith("+") ? `+${digits.slice(1).replace(/\+/g, "")}` : digits;
  return normalized.length >= 5 ? normalized : undefined;
}

export function assembleAddress(tags: Record<string, string>): string | undefined {
  const line1 = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const line2 = [tags["addr:postcode"], tags["addr:city"]].filter(Boolean).join(" ");
  const address = [line1, line2].filter((part) => part !== "").join(", ");
  return address === "" ? undefined : address;
}

const SOCIAL_KEYS = ["contact:instagram", "contact:facebook", "contact:twitter", "contact:mastodon"];

export function socialsFromTags(tags: Record<string, string>): Record<string, string> | undefined {
  const socials: Record<string, string> = {};
  for (const key of SOCIAL_KEYS) {
    const normalized = normalizeWebsite(tags[key]);
    if (normalized) socials[key.replace("contact:", "")] = normalized;
  }
  return Object.keys(socials).length > 0 ? socials : undefined;
}

const IDENTITY_TAG_LIMIT = 24;

/**
 * Bounded subset of tags useful for identity matching — not an unfiltered OSM copy
 * (book/src/place-identity.md).
 */
export function identityTagsFrom(tags: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  const primary = primaryCategory(tags);
  const exactKeys = [
    "name",
    "brand",
    "wikidata",
    "brand:wikidata",
    "website",
    "contact:website",
    "phone",
    "contact:phone",
    "addr:street",
    "addr:housenumber",
    "addr:city",
    "addr:postcode",
  ];
  if (primary) exactKeys.push(primary.key);
  for (const key of exactKeys) {
    const value = tags[key];
    if (value && Object.keys(picked).length < IDENTITY_TAG_LIMIT) picked[key] = value;
  }
  for (const [key, value] of Object.entries(tags)) {
    if (key.startsWith("ref:") && Object.keys(picked).length < IDENTITY_TAG_LIMIT) {
      picked[key] = value;
    }
  }
  return picked;
}

/** Build a ResolvedPoi from raw OSM element tags plus a representative point. */
export function resolvedPoiFromTags(params: {
  ref: OsmElementRef;
  tags: Record<string, string>;
  lat: number;
  lng: number;
  osmVersion?: number;
  resolvedAt: string;
}): ResolvedPoi {
  const { ref, tags, lat, lng, osmVersion, resolvedAt } = params;
  return {
    osmRef: ref,
    ...(osmVersion !== undefined ? { osmVersion } : {}),
    ...(tags.name ? { name: tags.name } : {}),
    category: deriveCategory(tags),
    lat,
    lng,
    ...(assembleAddress(tags) ? { address: assembleAddress(tags) } : {}),
    ...(websiteFromTags(tags) ? { website: websiteFromTags(tags) } : {}),
    ...(phoneFromTags(tags) ? { phone: phoneFromTags(tags) } : {}),
    ...(tags.opening_hours ? { openingHours: tags.opening_hours } : {}),
    ...(socialsFromTags(tags) ? { socials: socialsFromTags(tags) } : {}),
    identityTags: identityTagsFrom(tags),
    resolvedAt,
  };
}
