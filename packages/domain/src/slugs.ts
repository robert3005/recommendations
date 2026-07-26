/**
 * Client-side slug proposals (spec/src/sharing.md §The share service): the
 * client proposes a slug derived from the normalised title and walks `-2…-9`
 * suffixes on 403 (owned by another token) and 410 (tombstoned); if all are
 * taken, publish fails visibly. Server-side validation lives in
 * @placemarks/schemas.
 */

/** Normalised, url-safe: lowercase ascii letters/digits with single hyphens. */
export function slugFromTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug === "" ? "untitled" : slug;
}

/** The walk order: the base itself, then `base-2` … `base-9`. */
export function slugCandidates(base: string): string[] {
  const candidates = [base];
  for (let n = 2; n <= 9; n += 1) candidates.push(`${base}-${n}`);
  return candidates;
}
