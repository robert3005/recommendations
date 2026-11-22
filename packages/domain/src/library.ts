/**
 * Finding places in the library (spec/src/map-view.md §The library): tags,
 * the filter, and free-text matching, as pure functions. A place is matched
 * together with what is known about it from elsewhere — its lists and the
 * review-derived tags and text — so the caller assembles one `PlaceFacets`
 * per place and everything here stays free of storage.
 */
import type { Place, PlaceFilter } from "./entities";

/** A tag as stored: trimmed, lower-cased, inner whitespace collapsed, no leading #. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase().slice(0, 40);
}

/** Normalised, de-duplicated, sorted — the canonical stored form of a tag set. */
export function normalizeTags(raw: readonly string[]): string[] {
  return [...new Set(raw.map(normalizeTag).filter((tag) => tag !== ""))].sort();
}

/** Text folded for matching: lower case, diacritics and punctuation removed. */
export function foldText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[_;,/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A place plus everything a filter can ask about it. */
export interface PlaceFacets {
  place: Place;
  listIds: readonly string[];
  /** Tags the review classifier derived — never the owner's own. */
  derivedTags: readonly string[];
  /** Other review-derived text worth finding: the summary and dish names. */
  derivedText?: string;
}

/** The one string free text is matched against, folded. */
export function searchableText(facets: PlaceFacets): string {
  const { place } = facets;
  return foldText(
    [
      place.name,
      place.address,
      place.category,
      place.cuisine,
      place.description,
      place.note,
      ...(place.tags ?? []),
      ...facets.derivedTags,
      facets.derivedText,
    ]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(" \n "),
  );
}

/** True when no facet is set — the filter that matches the whole library. */
export function isEmptyFilter(filter: PlaceFilter): boolean {
  return (
    (filter.text ?? "").trim() === "" &&
    (filter.tags ?? []).length === 0 &&
    (filter.derivedTags ?? []).length === 0 &&
    (filter.listIds ?? []).length === 0 &&
    filter.minRating === undefined &&
    filter.status === undefined &&
    filter.unlisted !== true
  );
}

/** Drop empty facets so equal filters serialise equally. */
export function compactFilter(filter: PlaceFilter): PlaceFilter {
  const text = (filter.text ?? "").trim();
  return {
    ...(text !== "" ? { text } : {}),
    ...(filter.tags?.length ? { tags: normalizeTags(filter.tags) } : {}),
    ...(filter.derivedTags?.length ? { derivedTags: [...new Set(filter.derivedTags)].sort() } : {}),
    ...(filter.listIds?.length ? { listIds: [...new Set(filter.listIds)].sort() } : {}),
    ...(filter.minRating !== undefined ? { minRating: filter.minRating } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.unlisted === true ? { unlisted: true } : {}),
  };
}

/**
 * Every present facet must hold. Free text matches when every word of the
 * query appears somewhere in the place's searchable text, in any order — so
 * "cosy italian soho" finds a place tagged cosy, with Italian cuisine, on a
 * Soho address.
 */
export function matchesFilter(facets: PlaceFacets, filter: PlaceFilter): boolean {
  const { place } = facets;
  if (filter.unlisted === true && facets.listIds.length > 0) return false;
  if (filter.listIds?.length && !filter.listIds.some((id) => facets.listIds.includes(id))) {
    return false;
  }
  if (filter.minRating !== undefined && (place.rating ?? 0) < filter.minRating) return false;
  if (filter.status !== undefined && place.status !== filter.status) return false;
  if (filter.tags?.length) {
    const own = new Set(place.tags ?? []);
    if (!filter.tags.every((tag) => own.has(normalizeTag(tag)))) return false;
  }
  if (filter.derivedTags?.length) {
    const derived = new Set(facets.derivedTags);
    if (!filter.derivedTags.every((tag) => derived.has(tag))) return false;
  }
  const words = foldText(filter.text ?? "")
    .split(" ")
    .filter(Boolean);
  if (words.length > 0) {
    const haystack = searchableText(facets);
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

/** How often each tag occurs, most used first, then alphabetical. */
export function tagCounts(
  tagSets: readonly (readonly string[])[],
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tags of tagSets) for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/**
 * A provider's raw fact value as a person reads it: OSM writes
 * "bar_and_grill" and "coffee_shop;australian"; the screen says
 * "Bar and grill" and "Coffee shop · Australian".
 */
export function prettyFact(raw: string): string {
  return raw
    .split(";")
    .map((part) => part.replace(/_/g, " ").trim())
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
}

/** The one-line "category · cuisine" a listing shows, de-duplicated. */
export function placeKindLine(place: { category?: string; cuisine?: string }): string {
  const parts = [place.category, place.cuisine]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .flatMap((part) => prettyFact(part).split(" · "));
  const seen = new Set<string>();
  return parts
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" · ");
}
