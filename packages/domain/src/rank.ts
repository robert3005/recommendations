/** Fractional ranks for ordered guide blocks — thin wrapper over fractional-indexing. */
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export function rankBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a, b);
}

export function ranksBetween(a: string | null, b: string | null, n: number): string[] {
  return generateNKeysBetween(a, b, n);
}

/** Rank for appending after the current last rank (or the first rank of an empty list). */
export function rankAfter(lastRank: string | null): string {
  return generateKeyBetween(lastRank, null);
}
