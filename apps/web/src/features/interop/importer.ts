/**
 * The import pipeline (book/src/interop.md): parse → place via the coordinate
 * ladder → opportunistic OSM match → materialize through addToList — membership
 * is existence, so the import IS the adding-to-a-list. Idempotent: re-running
 * the same archive converges on the same places, upgrades them in place (an
 * import that later gains an OSM match links the existing PlaceId), and merges
 * source metadata. Every source row is accounted for — placed, duplicate,
 * review, or an explicit skipped row.
 */
import {
  classifyCandidates,
  displayFacts,
  type ExternalRef,
  type ManualFacts,
  normalizeName,
  type OsmEvidence,
  type Place,
  type PoiResolver,
  plausiblySameElement,
  type ResolvedPoi,
  type SearchProvider,
  type SearchResult,
  withExternalRef,
} from "@placemarks/domain";
import type { ImportBatchRow, ImportItemRow } from "../../data/db";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";
import { nextUnusedColor } from "../../lib/markers";
import { googleFeatureId, isGoogleMapsUrl, osmRefFromUrl } from "./googleUrl";
import { type ParsedItem, parseImportFile } from "./parse";

export interface ImportDeps {
  search: SearchProvider;
  resolver: PoiResolver;
}

export interface ImportReport {
  batchId: string;
  fileName: string;
  lists: number;
  /** Rows materialized as places this run (including OSM-linked ones). */
  placed: number;
  /** Subset of placed that were OSM-linked at import time. */
  linked: number;
  /** Rows that converged on an existing membership — a re-import, not new data. */
  duplicates: number;
  /** Rows waiting in the review queue. */
  review: number;
  /** Rows the user skipped, plus source rows that could not be parsed. */
  skipped: number;
}

function refForUrl(url: string, now: string): ExternalRef | undefined {
  if (isGoogleMapsUrl(url)) {
    const fid = googleFeatureId(url);
    return { provider: "google-maps", url, ...(fid ? { fid } : {}), importedAt: now };
  }
  // OSM portal URLs are typed anchors, not provenance refs; any other web URL
  // is retained with honest "web" provenance (never mislabeled as Google).
  if (osmRefFromUrl(url)) return undefined;
  if (/^https?:\/\//i.test(url)) return { provider: "web", url, importedAt: now };
  return undefined;
}

function allRefs(item: ParsedItem, now: string): ExternalRef[] {
  return [item.url, ...(item.urls ?? [])]
    .filter((url): url is string => typeof url === "string" && url !== "")
    .map((url) => refForUrl(url, now))
    .filter((ref): ref is ExternalRef => ref !== undefined);
}

/** The identity ref: a Google listing outranks generic web provenance, wherever it is listed. */
function externalRefFor(item: ParsedItem, now: string): ExternalRef | undefined {
  const refs = allRefs(item, now);
  return refs.find((ref) => ref.provider === "google-maps") ?? refs[0];
}

function extraRefs(item: ParsedItem, now: string): ExternalRef[] {
  const primary = externalRefFor(item, now);
  return allRefs(item, now).filter((ref) => ref.url !== primary?.url);
}

function factsFor(item: ParsedItem, coords: { lat: number; lng: number }): ManualFacts {
  return {
    name: item.title,
    lat: coords.lat,
    lng: coords.lng,
    ...(item.address ? { address: item.address } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.website ? { website: item.website } : {}),
    ...(item.phone ? { phone: item.phone } : {}),
    ...(item.openingHours ? { openingHours: item.openingHours } : {}),
  };
}

async function addImportNote(
  repo: DexieRepository,
  placeId: string,
  note: string,
  now: string,
): Promise<void> {
  // Idempotency: the same note body on the same place is not added twice.
  const existing = await repo.listNotesForPlace(placeId);
  if (existing.some((n) => n.body === note)) return;
  await repo.createNote({
    id: newId(),
    target: { kind: "place", placeId },
    body: note,
    mediaIds: [],
    shareable: false,
    createdAt: now,
    updatedAt: now,
  });
}

interface Materialized {
  status: "placed" | "duplicate";
  linked: boolean;
  placeId: string;
}

/**
 * Materialize one placed item — with or without an OSM match. Converging on an
 * existing place still merges the source URL, links an unlinked place when a
 * match arrived, and imports the note; only the membership decides
 * placed-vs-duplicate.
 */
async function materializeItem(
  repo: DexieRepository,
  listId: string,
  item: ParsedItem,
  coords: { lat: number; lng: number },
  poi: ResolvedPoi | undefined,
  now: string,
  options: {
    exactAnchor?: boolean;
    probeRef?: { type: "node" | "way" | "relation"; id: string };
  } = {},
): Promise<Materialized | { status: "review" }> {
  const externalRef = externalRefFor(item, now);
  const facts = factsFor(item, coords);
  // Identity precedence: external-ref id, then the exact OSM ref, then
  // name+proximity — which is conservative and refuses to guess when several
  // local places could be meant. An exact anchor IS the identity: fuzzy
  // name matching never overrides it onto a different element.
  const probed = await repo.findImportTarget(
    facts,
    externalRef,
    poi?.osmRef ?? options.probeRef,
    options.exactAnchor === true,
  );
  if (probed === "ambiguous") return { status: "review" };
  const existing = probed;

  let place: Place;
  let status: Materialized["status"];
  if (existing) {
    const inList = (await repo.listIdsForPlace(existing.id)).includes(listId);
    if (inList) {
      status = "duplicate";
      place = existing;
    } else {
      status = "placed";
      place = (await repo.addToList(listId, { kind: "existing", placeId: existing.id }, now)).place;
    }
    // A duplicate row is not a no-op: the source URL(s) and imported facts
    // merge onto the retained place, and a newly gained OSM match upgrades
    // the same PlaceId.
    let merged = place;
    for (const ref of [externalRef, ...extraRefs(item, now)]) {
      if (ref) merged = withExternalRef(merged, ref, now);
    }
    if (!merged.manual) merged = { ...merged, manual: facts, updatedAt: now };
    if (poi && !merged.currentOsmRef) {
      merged = await repo.linkImportedPlace(merged, poi, now);
    } else if (merged !== place) {
      await repo.updatePlace(merged);
    }
    place = merged;
  } else {
    status = "placed";
    place = (
      await repo.addToList(
        listId,
        {
          kind: "import",
          facts,
          ...(externalRef ? { externalRef } : {}),
          ...(poi ? { poi } : {}),
          ...(options.exactAnchor === true ? { authoritative: true } : {}),
        },
        now,
      )
    ).place;
    let withExtras = place;
    for (const ref of extraRefs(item, now)) withExtras = withExternalRef(withExtras, ref, now);
    if (withExtras !== place) {
      await repo.updatePlace(withExtras);
      place = withExtras;
    }
  }

  if (item.note) await addImportNote(repo, place.id, item.note, now);
  for (const tag of item.tags ?? []) await repo.assignTag(place.id, tag, now);
  return { status, linked: place.currentOsmRef !== undefined, placeId: place.id };
}

/**
 * Opportunistic OSM linking for a coordinate-bearing row: one unique
 * high-confidence candidate within a tight radius, judged by the conservative
 * identity ladder — never distance alone. Failures are silent; linking is an
 * upgrade, not a gate.
 */
async function nearbyMatch(
  deps: ImportDeps,
  item: ParsedItem,
  coords: { lat: number; lng: number },
): Promise<ResolvedPoi | undefined> {
  try {
    const candidates = await deps.resolver.searchNearby({
      lat: coords.lat,
      lng: coords.lng,
      radiusM: 100,
    });
    const evidence: OsmEvidence = {
      ref: { type: "node", id: "0" }, // placeholder — scoring never uses the ref
      source: "OpenStreetMap",
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      name: item.title,
      category: item.category ?? "",
      lat: coords.lat,
      lng: coords.lng,
      ...(item.address ? { address: item.address } : {}),
      identityTags: {},
      observedAt: "",
    };
    const classified = classifyCandidates(evidence, candidates);
    return classified.kind === "auto" ? classified.best.candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A fetched exact element that is no longer plausibly the imported place
 * (moved far away with incompatible identity) must not be blindly accepted.
 */
function anchorPlausible(item: ParsedItem, poi: ResolvedPoi): boolean {
  if (item.coords) {
    const evidence: OsmEvidence = {
      ref: poi.osmRef,
      source: "OpenStreetMap",
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      name: item.title,
      category: item.category ?? poi.category,
      lat: item.coords.lat,
      lng: item.coords.lng,
      identityTags: {},
      observedAt: "",
    };
    return plausiblySameElement(evidence, poi);
  }
  // Without coordinates, the name and address are the only identity signals a
  // Takeout row carries — an element that matches neither has been repurposed.
  const nameMatches = normalizeName(item.title) === normalizeName(poi.name);
  const addressOk = addressCompatible(item.address, {
    ref: poi.osmRef,
    name: poi.name ?? "",
    lat: poi.lat,
    lng: poi.lng,
    ...(poi.address ? { address: poi.address } : {}),
  });
  return nameMatches || (item.address !== undefined && addressOk && item.category === poi.category);
}

const normalizeAddressTokens = (address: string): Set<string> =>
  new Set(
    address
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

/** Two present addresses must share ≥2 tokens; a missing address cannot contradict. */
function addressCompatible(rowAddress: string | undefined, candidate: SearchResult): boolean {
  if (!rowAddress || !candidate.address) return true;
  const row = normalizeAddressTokens(rowAddress);
  let shared = 0;
  for (const token of normalizeAddressTokens(candidate.address)) {
    if (row.has(token)) shared += 1;
  }
  return shared >= 2;
}

/**
 * The geocode rung: title(+address) through the search adapter; a candidate
 * qualifies for auto-linking only with a matching normalized name AND a
 * non-contradicting address. One unique qualifier auto-places; anything else
 * is a review case.
 */
async function geocode(
  deps: ImportDeps,
  item: ParsedItem,
): Promise<
  { kind: "auto"; result: SearchResult } | { kind: "review"; candidates: SearchResult[] }
> {
  const query = [item.title, item.address].filter(Boolean).join(", ");
  let results: SearchResult[] = [];
  try {
    results = await deps.search.search(query, { limit: 8 });
    if (results.length === 0 && item.address) {
      results = await deps.search.search(item.title, { limit: 8 });
    }
  } catch {
    // Geocoder unavailable → review, never a dropped row.
    return { kind: "review", candidates: [] };
  }
  const wanted = normalizeName(item.title);
  const named = results.filter((r) => normalizeName(r.name) === wanted);
  // A name match alone never links (chains exist everywhere): the row must
  // carry an address that does not contradict the candidate — and a
  // category-contradicting candidate (cafe vs school) goes to review too.
  const qualified = (
    item.address ? named.filter((r) => addressCompatible(item.address, r)) : []
  ).filter(
    (r) =>
      !item.category || !r.category || normalizeName(r.category) === normalizeName(item.category),
  );
  const uniqueRefs = new Set(qualified.map((r) => `${r.ref.type}/${r.ref.id}`));
  if (qualified.length > 0 && uniqueRefs.size === 1 && qualified[0]) {
    return { kind: "auto", result: qualified[0] };
  }
  return { kind: "review", candidates: (named.length > 0 ? named : results).slice(0, 5) };
}

/**
 * Resolve a search candidate to a full POI. An exact-resolve failure keeps the
 * row in review: placing it at bare geocoder coordinates would ship OSM-derived
 * data without evidence or attribution (book/src/interop.md licensing valves).
 */
async function materializeCandidate(
  repo: DexieRepository,
  deps: ImportDeps,
  listId: string,
  item: ParsedItem,
  result: SearchResult,
  now: string,
): Promise<Materialized | { status: "review" }> {
  try {
    const outcome = await deps.resolver.resolveExact(result.ref);
    if (outcome.type !== "ok") return { status: "review" };
    return await materializeItem(repo, listId, item, result, outcome.poi, now);
  } catch {
    // Provider unavailability never consumes the row — it stays reviewable.
    return { status: "review" };
  }
}

/**
 * Source-list identity: the first import binds the source name to a local list;
 * later re-imports follow the binding even after the user renames the list.
 * Only then does a plain name match apply, and only then is a list created.
 */
async function listIdForSource(
  repo: DexieRepository,
  sourceName: string,
  sourceColor: string | undefined,
  now: string,
): Promise<string> {
  const bound = await repo.db.importSources.get(sourceName);
  if (bound) {
    const list = await repo.getList(bound.listId);
    if (list) return list.id;
  }
  const lists = await repo.listLists();
  const existing = lists.find((l) => l.name === sourceName);
  const id = existing?.id ?? newId();
  if (!existing) {
    await repo.createList({
      id,
      name: sourceName,
      color: sourceColor ?? nextUnusedColor(lists),
      createdAt: now,
      updatedAt: now,
    });
  }
  await repo.db.importSources.put({ sourceKey: sourceName, listId: id });
  return id;
}

const reviewKey = (listId: string, raw: ImportItemRow["raw"]): string =>
  [listId, raw.title, raw.url ?? "", raw.address ?? ""].join("|");

export async function runImport(
  repo: DexieRepository,
  file: { name: string; bytes: Uint8Array },
  deps: ImportDeps,
  now: string,
): Promise<ImportReport> {
  const parsed = await parseImportFile(file);
  const batch: ImportBatchRow = {
    id: newId(),
    source: parsed.source,
    fileName: file.name,
    startedAt: now,
    status: "reviewing",
  };
  await repo.db.importBatches.put(batch);

  // Identical unresolved rows must not pile up across re-imports.
  const pendingReview = new Set(
    (await repo.db.importItems.filter((i) => i.status === "review").toArray()).map((i) =>
      reviewKey(i.targetListId, i.raw),
    ),
  );

  const report: ImportReport = {
    batchId: batch.id,
    fileName: file.name,
    lists: parsed.lists.length,
    placed: 0,
    linked: 0,
    duplicates: 0,
    review: 0,
    skipped: 0,
  };

  for (const list of parsed.lists) {
    // A list holding only unusable rows is bookkeeping, not a real list.
    const listId =
      list.items.length > 0 ? await listIdForSource(repo, list.name, list.color, now) : "";
    for (const row of list.unusable) {
      // Unusable source rows are persisted, not just counted.
      await repo.db.importItems.put({
        id: newId(),
        batchId: batch.id,
        targetListId: listId,
        raw: row,
        status: "skipped",
      });
      report.skipped += 1;
    }
    for (const item of list.items) {
      const row: ImportItemRow = {
        id: newId(),
        batchId: batch.id,
        targetListId: listId,
        raw: {
          title: item.title,
          ...(item.note ? { note: item.note } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.urls ? { urls: item.urls } : {}),
          ...(item.address ? { address: item.address } : {}),
          ...(item.category ? { category: item.category } : {}),
          ...(item.phone ? { phone: item.phone } : {}),
          ...(item.openingHours ? { openingHours: item.openingHours } : {}),
          ...(item.tags ? { tags: item.tags } : {}),
          ...(item.osmRef ? { osmRef: item.osmRef } : {}),
        },
        ...(item.coords ? { coords: item.coords } : {}),
        status: "review",
      };

      let outcome: Materialized | { status: "review" } | undefined;
      const osmRef = osmRefFromUrl(item.url) ?? item.osmRef;
      if (osmRef) {
        // A typed OSM anchor (portal URL or our own export) resolves exactly —
        // and the anchor is persisted on the row so a retry keeps it. A local
        // place already carrying the ref (current or historical) is the same
        // place even when the resolver is unreachable.
        row.raw.url ??= `https://www.openstreetmap.org/${osmRef.type}/${osmRef.id}`;
        const known = await repo.findPlaceByOsmRef(osmRef);
        if (known) {
          const knownFacts = displayFacts(known);
          outcome = await materializeItem(
            repo,
            listId,
            item,
            item.coords ?? { lat: knownFacts?.lat ?? 0, lng: knownFacts?.lng ?? 0 },
            undefined,
            now,
            { exactAnchor: true, probeRef: osmRef },
          );
        } else {
          try {
            const resolved = await deps.resolver.resolveExact(osmRef);
            if (resolved.type === "ok" && anchorPlausible(item, resolved.poi)) {
              outcome = await materializeItem(repo, listId, item, resolved.poi, resolved.poi, now, {
                exactAnchor: true,
              });
            } else if (resolved.type === "gone") {
              // The anchored element was redrawn: an existing local place that
              // carries this ref in its HISTORY is the same place — converge.
              const historical = await repo.findPlaceByOsmRef(osmRef);
              if (historical) {
                const facts = displayFacts(historical);
                outcome = await materializeItem(
                  repo,
                  listId,
                  item,
                  item.coords ?? { lat: facts?.lat ?? 0, lng: facts?.lng ?? 0 },
                  undefined,
                  now,
                  { exactAnchor: true, probeRef: osmRef },
                );
              }
            }
            // incompatible/unavailable → the row stays in review.
          } catch {
            // Provider rejection never consumes the row.
          }
        }
      } else if (item.coords) {
        // Opportunistic OSM match (book/src/interop.md): a unique high-confidence
        // nearby candidate links the place; nothing blocks on it.
        const nearby = await nearbyMatch(deps, item, item.coords);
        outcome = await materializeItem(repo, listId, item, item.coords, nearby, now);
      } else {
        const rung = await geocode(deps, item);
        if (rung.kind === "auto") {
          const attempt = await materializeCandidate(repo, deps, listId, item, rung.result, now);
          if (attempt.status === "review") row.candidates = [rung.result];
          else outcome = attempt;
        } else {
          row.candidates = rung.candidates;
        }
      }

      if (outcome && outcome.status !== "review") {
        row.status = outcome.status;
        row.linkedOsm = outcome.linked;
        row.placeId = outcome.placeId;
        if (outcome.status === "placed") {
          report.placed += 1;
          if (outcome.linked) report.linked += 1;
        } else {
          report.duplicates += 1;
        }
        await repo.db.importItems.put(row);
        // A resolved row supersedes any identical still-pending review row.
        const key = reviewKey(listId, row.raw);
        if (pendingReview.has(key)) {
          pendingReview.delete(key);
          const stale = await repo.db.importItems
            .filter(
              (i) =>
                i.status === "review" &&
                i.id !== row.id &&
                reviewKey(i.targetListId, i.raw) === key,
            )
            .toArray();
          for (const staleRow of stale) await repo.db.importItems.delete(staleRow.id);
        }
      } else {
        // Every source row is accounted for. An identical row already pending
        // moves to this batch (no queue duplication, no orphan accounting).
        const key = reviewKey(listId, row.raw);
        report.review += 1;
        if (pendingReview.has(key)) {
          const existing = await repo.db.importItems
            .filter((i) => i.status === "review" && reviewKey(i.targetListId, i.raw) === key)
            .first();
          // Newer source metadata (note, coords, candidates) wins on re-import.
          if (existing) {
            await repo.db.importItems.put({
              ...existing,
              batchId: batch.id,
              raw: row.raw,
              ...(row.coords ? { coords: row.coords } : {}),
              ...(row.candidates ? { candidates: row.candidates } : {}),
            });
          }
        } else {
          pendingReview.add(key);
          await repo.db.importItems.put(row);
        }
      }
    }
  }

  if (report.review === 0) {
    await repo.db.importBatches.put({ ...batch, status: "done" });
  }
  return report;
}

export type ReviewChoice =
  | { kind: "candidate"; ref: SearchResult["ref"] }
  | { kind: "coords"; lat: number; lng: number }
  | { kind: "skip" };

/** Resolve one review-queue item: pick a candidate, place manually, or skip. */
export async function resolveReviewItem(
  repo: DexieRepository,
  deps: ImportDeps,
  itemId: string,
  choice: ReviewChoice,
  now: string,
): Promise<void> {
  const row = await repo.db.importItems.get(itemId);
  if (row?.status !== "review") return;
  const item: ParsedItem = { ...row.raw };

  if (choice.kind === "skip") {
    await repo.db.importItems.put({ ...row, status: "skipped" });
  } else if (choice.kind === "coords") {
    if (
      !Number.isFinite(choice.lat) ||
      !Number.isFinite(choice.lng) ||
      choice.lat < -90 ||
      choice.lat > 90 ||
      choice.lng < -180 ||
      choice.lng > 180
    ) {
      throw new Error("out-of-range coordinate — the item stays in review");
    }
    const placed = await materializeItem(repo, row.targetListId, item, choice, undefined, now);
    if (placed.status === "review") return; // ambiguous locally — still reviewable
    // ODbL continuity: a manually placed row that descends from an OSM anchor
    // keeps that provenance on the place (as unresolved link history), so
    // exports keep attributing the facts correctly.
    const anchorRef = item.osmRef ?? (item.url ? osmRefFromUrl(item.url) : undefined);
    if (anchorRef && placed.placeId) {
      const place = await repo.getPlace(placed.placeId);
      if (place && !place.currentOsmRef && place.osmRefHistory.length === 0) {
        await repo.updatePlace({
          ...place,
          osmRefHistory: [{ ref: anchorRef, linkedAt: now, unlinkedAt: now, reason: "replaced" }],
          updatedAt: now,
        });
      }
    }
    await repo.db.importItems.put({
      ...row,
      status: placed.status,
      coords: { lat: choice.lat, lng: choice.lng },
      linkedOsm: placed.linked,
      placeId: placed.placeId,
    });
  } else {
    const candidate = (row.candidates ?? []).find(
      (c) => c.ref.type === choice.ref.type && c.ref.id === choice.ref.id,
    );
    if (!candidate) return;
    const placed = await materializeCandidate(repo, deps, row.targetListId, item, candidate, now);
    if (placed.status === "review") return; // resolve failed — the item stays reviewable
    await repo.db.importItems.put({
      ...row,
      status: placed.status,
      linkedOsm: placed.linked,
      placeId: placed.placeId,
    });
  }

  const remaining = await repo.db.importItems
    .where("batchId")
    .equals(row.batchId)
    .filter((i) => i.status === "review")
    .count();
  if (remaining === 0) {
    const batch = await repo.db.importBatches.get(row.batchId);
    if (batch) await repo.db.importBatches.put({ ...batch, status: "done" });
  }
}
