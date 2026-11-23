/**
 * The auto-place rule of the import coordinate ladder (spec/src/interop.md
 * §The coordinate ladder): a geocoder result auto-places only on evidence —
 * its name matches the row, its address does not contradict it, and it is
 * either the only result or the only one corroborated by the row's address
 * or by the rest of the list; anything else goes to the review queue. Geocoder errors are not misses —
 * pausing the rung is the importer's job, not this module's.
 */
import type { GeocoderCandidate } from "./entities";

/**
 * NFKC, accents folded ("Zédel" is "Zedel" — sources disagree on them),
 * lowercased, punctuation collapsed to single spaces.
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
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

function wordTokens(text: string): string[] {
  return normalizeName(text)
    .split(" ")
    .filter((word) => word.length >= 4 && !/^\d+$/.test(word));
}

/**
 * Positive evidence that two addresses name the same spot: a shared number
 * (house number, postcode part) or two shared words (street and city).
 */
function addressesCorroborate(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const numbersB = numberTokens(b);
  if (numberTokens(a).some((n) => numbersB.includes(n))) return true;
  const wordsB = new Set(wordTokens(b));
  return wordTokens(a).filter((word) => wordsB.has(word)).length >= 2;
}

/**
 * The row names the candidate: the normalised names are equal, or the row
 * adds words to the candidate's name that the candidate's own address
 * accounts for — "Time Out Market Lisboa" is "Time Out Market" in Lisboa.
 */
function namesMatch(rowName: string, candidate: GeocoderCandidate): boolean {
  const name = normalizeName(candidate.name);
  if (name === "") return false;
  if (rowName === name) return true;
  const rest = rowName.startsWith(`${name} `)
    ? rowName.slice(name.length + 1)
    : rowName.endsWith(` ${name}`)
      ? rowName.slice(0, -name.length - 1)
      : undefined;
  if (rest === undefined || !candidate.address) return false;
  const address = ` ${normalizeName(candidate.address)} `;
  return rest.split(" ").every((word) => address.includes(` ${word} `));
}

/**
 * The candidate's name merely BEGINS with the row's — "Manteigaria" against
 * "Manteigaria – Fábrica de Pastéis de Nata". Too weak to stand alone: such a
 * candidate only ever wins on a strong address match.
 */
function nameExtendsRow(rowName: string, candidate: GeocoderCandidate): boolean {
  return normalizeName(candidate.name).startsWith(`${rowName} `);
}

/** A shared number AND two shared words: the same door, street and town. */
function addressesAgreeStrongly(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const numbersB = numberTokens(b);
  const wordsB = new Set(wordTokens(b));
  return (
    numberTokens(a).some((n) => numbersB.includes(n)) &&
    wordTokens(a).filter((word) => wordsB.has(word)).length >= 2
  );
}

/** Great-circle distance in kilometres — coarse is fine at this scale. */
function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Two same-named results this close are one venue listed twice (OSM and Foursquare, say). */
const SAME_VENUE_KM = 0.15;

/**
 * Drops results that repeat another: the same name within SAME_VENUE_KM, from
 * a source without an osmRef. The OSM-sourced copy is kept.
 */
function withoutDuplicates(candidates: GeocoderCandidate[]): GeocoderCandidate[] {
  const ordered = [...candidates.filter((c) => c.osmRef), ...candidates.filter((c) => !c.osmRef)];
  const kept: GeocoderCandidate[] = [];
  for (const candidate of ordered) {
    const name = normalizeName(candidate.name);
    // Two distinct OSM elements stay two: only a copy from another source
    // (no osmRef of its own) is folded into an earlier listing.
    const repeat =
      !candidate.osmRef &&
      kept.some((k) => normalizeName(k.name) === name && kmBetween(k, candidate) <= SAME_VENUE_KM);
    if (!repeat) kept.push(candidate);
  }
  // Original order among the survivors: callers read the first as the best.
  return candidates.filter((c) => kept.includes(c));
}

/** A candidate this close to a place already on the list is plausibly the one meant. */
export const NEAR_LIST_KM = 40;

/**
 * Where to lean a geocoder query for a list: the middle of its placed rows,
 * but only while they sit together — a list spanning countries has no middle
 * worth leaning toward.
 */
export function listBias(
  anchors: readonly { lat: number; lng: number }[],
): { lat: number; lng: number } | undefined {
  if (anchors.length === 0) return undefined;
  const lat = anchors.reduce((sum, a) => sum + a.lat, 0) / anchors.length;
  const lng = anchors.reduce((sum, a) => sum + a.lng, 0) / anchors.length;
  const centre = { lat, lng };
  return anchors.every((a) => kmBetween(centre, a) <= 150) ? centre : undefined;
}

/**
 * Auto-place only on evidence; everything else goes to review.
 *
 *  - The candidates considered are those whose name matches the row and whose
 *    address does not contradict the row's.
 *  - A lone geocoder result that qualifies auto-places (the original rule).
 *  - A result whose name only begins with the row's counts when its address
 *    agrees strongly with the row's (a shared number and two shared words).
 *  - Among several results, exactly one must be corroborated — first by the
 *    address (a shared number, or street and city), and failing that by
 *    sitting near a place already on the list (`near`, the list's placed
 *    rows) while no other qualifying candidate does.
 *
 * No scoring: each step is a yes/no test, and a tie is always a review.
 */
export function autoPlaceDecision(
  row: { title: string; address?: string },
  candidates: GeocoderCandidate[],
  opts?: { near?: readonly { lat: number; lng: number }[] },
): { kind: "auto"; candidate: GeocoderCandidate } | { kind: "review" } {
  const rowName = normalizeName(row.title);
  if (rowName === "") return { kind: "review" };
  const qualifying = withoutDuplicates(
    candidates.filter(
      (candidate) =>
        namesMatch(rowName, candidate) && !addressesContradict(row.address, candidate.address),
    ),
  );
  if (withoutDuplicates(candidates).length === 1 && qualifying.length === 1) {
    return { kind: "auto", candidate: qualifying[0] as GeocoderCandidate };
  }

  const byAddress = [
    ...qualifying.filter((c) => addressesCorroborate(row.address, c.address)),
    // A longer name at exactly the row's address is the row's place too.
    ...candidates.filter(
      (c) =>
        !qualifying.includes(c) &&
        nameExtendsRow(rowName, c) &&
        addressesAgreeStrongly(row.address, c.address),
    ),
  ];
  if (byAddress.length === 1) return { kind: "auto", candidate: byAddress[0] as GeocoderCandidate };
  if (byAddress.length > 1) return { kind: "review" };

  const near = opts?.near ?? [];
  if (near.length > 0) {
    const nearby = qualifying.filter((c) =>
      near.some((anchor) => kmBetween(anchor, c) <= NEAR_LIST_KM),
    );
    if (nearby.length === 1) return { kind: "auto", candidate: nearby[0] as GeocoderCandidate };
  }
  return { kind: "review" };
}
