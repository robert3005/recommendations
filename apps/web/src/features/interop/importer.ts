/**
 * The import pipeline (book/src/interop.md): parse → place via the coordinate
 * ladder → opportunistic OSM match → materialize through addToList — membership
 * is existence, so the import IS the adding-to-a-list. Idempotent: re-running
 * the same archive converges (external-ref/name+proximity dedup in the repo,
 * per-list uniqueness surfacing as `duplicate`). Every row is accounted for.
 */
import {
  type ExternalRef,
  type ManualFacts,
  normalizeName,
  type PoiResolver,
  type SearchProvider,
  type SearchResult,
} from "@placemarks/domain";
import type { ImportBatchRow, ImportItemRow } from "../../data/db";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";
import { nextUnusedColor } from "../../lib/markers";
import { googleFeatureId } from "./googleUrl";
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

function externalRefFor(item: ParsedItem, now: string): ExternalRef | undefined {
  if (!item.url) return undefined;
  const fid = googleFeatureId(item.url);
  return { provider: "google-maps", url: item.url, ...(fid ? { fid } : {}), importedAt: now };
}

function factsFor(item: ParsedItem, coords: { lat: number; lng: number }): ManualFacts {
  return {
    name: item.title,
    lat: coords.lat,
    lng: coords.lng,
    ...(item.address ? { address: item.address } : {}),
  };
}

const DUPLICATE_MESSAGE = "place already in this list";

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

/** Materialize one placed item; returns its final status. */
async function materialize(
  repo: DexieRepository,
  listId: string,
  item: ParsedItem,
  coords: { lat: number; lng: number },
  now: string,
): Promise<{ status: "placed" | "duplicate"; placeId?: string }> {
  try {
    const view = await repo.addToList(
      listId,
      { kind: "import", facts: factsFor(item, coords), externalRef: externalRefFor(item, now) },
      now,
    );
    if (item.note) await addImportNote(repo, view.place.id, item.note, now);
    return { status: "placed", placeId: view.place.id };
  } catch (err) {
    if (err instanceof Error && err.message === DUPLICATE_MESSAGE) {
      return { status: "duplicate" };
    }
    throw err;
  }
}

/**
 * The geocode rung: title(+address) through the search adapter; candidates
 * whose normalized name matches the row's title. One unique match auto-places
 * (and OSM-links); anything else is a review case.
 */
async function geocode(
  deps: ImportDeps,
  item: ParsedItem,
): Promise<{ kind: "auto"; result: SearchResult } | { kind: "review"; candidates: SearchResult[] }> {
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
  const uniqueRefs = new Set(named.map((r) => `${r.ref.type}/${r.ref.id}`));
  if (named.length > 0 && uniqueRefs.size === 1 && named[0]) {
    return { kind: "auto", result: named[0] };
  }
  return { kind: "review", candidates: (named.length > 0 ? named : results).slice(0, 5) };
}

/** OSM-link a search candidate and add it to the list through the poi source. */
async function materializeLinked(
  repo: DexieRepository,
  deps: ImportDeps,
  listId: string,
  item: ParsedItem,
  result: SearchResult,
  now: string,
): Promise<{ status: "placed" | "duplicate"; linked: boolean; placeId?: string }> {
  const outcome = await deps.resolver.resolveExact(result.ref);
  if (outcome.type !== "ok") {
    // Exact resolution failed → fall back to a placed-but-unlinked import.
    const placed = await materialize(repo, listId, item, result, now);
    return { ...placed, linked: false };
  }
  try {
    const view = await repo.addToList(
      listId,
      { kind: "poi", poi: outcome.poi, externalRef: externalRefFor(item, now) },
      now,
    );
    if (item.note) await addImportNote(repo, view.place.id, item.note, now);
    return { status: "placed", linked: true, placeId: view.place.id };
  } catch (err) {
    if (err instanceof Error && err.message === DUPLICATE_MESSAGE) {
      return { status: "duplicate", linked: true };
    }
    throw err;
  }
}

async function listIdForName(repo: DexieRepository, name: string, now: string): Promise<string> {
  // Idempotent re-import targets the same list by name.
  const lists = await repo.listLists();
  const existing = lists.find((l) => l.name === name);
  if (existing) return existing.id;
  const id = newId();
  await repo.createList({
    id,
    name,
    color: nextUnusedColor(lists),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

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
    report.skipped += list.dropped;
    const listId = await listIdForName(repo, list.name, now);
    for (const item of list.items) {
      const row: ImportItemRow = {
        id: newId(),
        batchId: batch.id,
        targetListId: listId,
        raw: {
          title: item.title,
          ...(item.note ? { note: item.note } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.address ? { address: item.address } : {}),
        },
        ...(item.coords ? { coords: item.coords } : {}),
        status: "review",
      };

      if (item.coords) {
        const placed = await materialize(repo, listId, item, item.coords, now);
        row.status = placed.status;
        if (placed.placeId) row.placeId = placed.placeId;
      } else {
        const rung = await geocode(deps, item);
        if (rung.kind === "auto") {
          const placed = await materializeLinked(repo, deps, listId, item, rung.result, now);
          row.status = placed.status;
          row.linkedOsm = placed.linked;
          if (placed.placeId) row.placeId = placed.placeId;
        } else {
          row.candidates = rung.candidates;
        }
      }

      if (row.status === "placed") {
        report.placed += 1;
        if (row.linkedOsm) report.linked += 1;
      } else if (row.status === "duplicate") report.duplicates += 1;
      else if (row.status === "review") report.review += 1;
      await repo.db.importItems.put(row);
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
  if (!row || row.status !== "review") return;
  const item: ParsedItem = { ...row.raw };

  if (choice.kind === "skip") {
    await repo.db.importItems.put({ ...row, status: "skipped" });
  } else if (choice.kind === "coords") {
    const placed = await materialize(repo, row.targetListId, item, choice, now);
    await repo.db.importItems.put({
      ...row,
      status: placed.status,
      coords: { lat: choice.lat, lng: choice.lng },
      ...(placed.placeId ? { placeId: placed.placeId } : {}),
    });
  } else {
    const candidate = (row.candidates ?? []).find(
      (c) => c.ref.type === choice.ref.type && c.ref.id === choice.ref.id,
    );
    if (!candidate) return;
    const placed = await materializeLinked(repo, deps, row.targetListId, item, candidate, now);
    await repo.db.importItems.put({
      ...row,
      status: placed.status,
      linkedOsm: placed.linked,
      ...(placed.placeId ? { placeId: placed.placeId } : {}),
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
