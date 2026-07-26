/**
 * The auto-place rule of the import coordinate ladder (spec/src/interop.md
 * §The coordinate ladder): a single geocoder result whose normalised name
 * matches the row title and whose address does not contradict auto-places;
 * anything else goes to the review queue. Geocoder errors are not misses —
 * pausing the rung is the importer's job, not this module's.
 */
import type { GeocoderCandidate } from "./entities";

/** NFKC, lowercased, punctuation collapsed to single spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Addresses contradict only on conflicting numbers (house number, etc.):
 * textual formats differ too wildly between sources to call a mismatch a
 * contradiction, but "12 Main St" against "14 Main Street" is one.
 */
function addressesContradict(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const numbersA = numberTokens(a);
  const numbersB = numberTokens(b);
  if (numbersA.length === 0 || numbersB.length === 0) return false;
  return !numbersA.some((n) => numbersB.includes(n));
}

function numberTokens(address: string): string[] {
  return (address.match(/\d+/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ""));
}

/** Single candidate + normalised-name match + non-contradicting address → auto. */
export function autoPlaceDecision(
  row: { title: string; address?: string },
  candidates: GeocoderCandidate[],
): { kind: "auto"; candidate: GeocoderCandidate } | { kind: "review" } {
  if (candidates.length !== 1) return { kind: "review" };
  const candidate = candidates[0] as GeocoderCandidate;
  const rowName = normalizeName(row.title);
  if (rowName === "" || rowName !== normalizeName(candidate.name)) return { kind: "review" };
  if (addressesContradict(row.address, candidate.address)) return { kind: "review" };
  return { kind: "auto", candidate };
}
