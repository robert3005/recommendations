/**
 * The owner's star rating (spec/src/data-model.md §The personal layer): half a
 * star to five, in half steps. Libraries from before the five-star scale held
 * a three-step `rating` (1 good · 2 great · 3 favourite); every way a row comes
 * in — the local store, sync, a backup — passes through the upgrades here, so
 * the old field never reaches the rest of the app.
 */
import type { Place, PlaceFilter, SavedView } from "./entities";

/** Every value a rating can take, lowest first. */
export const STAR_VALUES: readonly number[] = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

/** The minimum-rating filter's choices (spec/src/map-view.md §The library). */
export const MIN_STAR_CHOICES: readonly number[] = [1, 2, 3, 3.5, 4, 4.5, 5];

/** A value on the scale: 0.5–5 in half steps. */
export function isStars(value: unknown): value is number {
  return typeof value === "number" && value >= 0.5 && value <= 5 && Number.isInteger(value * 2);
}

/** good → 3, great → 4, favourite → 5. */
export function starsFromLegacyRating(rating: unknown): number | undefined {
  return rating === 1 ? 3 : rating === 2 ? 4 : rating === 3 ? 5 : undefined;
}

/** "4", "3.5" — how a rating reads in text. */
export function formatStars(stars: number): string {
  return Number.isInteger(stars) ? stars.toString() : stars.toFixed(1);
}

/**
 * A place as the app knows it: a legacy `rating` becomes `stars` (unless the
 * row already carries stars), and an off-scale value is dropped. Returns the
 * same object when there is nothing to change.
 */
export function upgradePlaceStars<T extends Place>(place: T): T {
  const raw = place as T & { rating?: unknown };
  const hasLegacy = "rating" in raw;
  const starsOk = raw.stars === undefined || isStars(raw.stars);
  if (!hasLegacy && starsOk) return place;
  const { rating, stars: _stars, ...rest } = raw;
  const stars = isStars(raw.stars) ? raw.stars : starsFromLegacyRating(rating);
  return { ...rest, ...(stars !== undefined ? { stars } : {}) } as unknown as T;
}

/** A filter's legacy `minRating` becomes `minStars` on the same mapping. */
export function upgradeFilterStars(filter: PlaceFilter): PlaceFilter {
  const raw = filter as PlaceFilter & { minRating?: unknown };
  const hasLegacy = "minRating" in raw;
  const minOk = raw.minStars === undefined || isStars(raw.minStars);
  if (!hasLegacy && minOk) return filter;
  const { minRating, minStars: _min, ...rest } = raw;
  const minStars = isStars(raw.minStars) ? raw.minStars : starsFromLegacyRating(minRating);
  return { ...rest, ...(minStars !== undefined ? { minStars } : {}) };
}

export function upgradeViewStars<T extends SavedView>(view: T): T {
  if (view.filter == null) return view;
  const filter = upgradeFilterStars(view.filter);
  return filter === view.filter ? view : { ...view, filter };
}
