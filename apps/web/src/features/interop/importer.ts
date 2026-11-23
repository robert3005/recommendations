/**
 * The import pipeline (spec/src/interop.md): parse → the coordinate ladder →
 * materialize through addToList — an import arrives as lists, so every row
 * lands on its source list. Idempotent: re-running the same archive converges via
 * the pinned dedup precedence (Google feature id → osmRef → name+proximity)
 * and never deletes — the user's edits are canon. Every source row and every
 * Saved Places entry is accounted for: placed, in review, or skipped.
 */
import type { GeocoderCandidate, ImportBatch, ImportItem, List, Place } from "@placemarks/domain";
import { autoPlaceDecision, googleFeatureId, listBias, parsePastedLink } from "@placemarks/domain";
import type { LocalRepository, NewPlaceFacts } from "../../data/repo";
import { newId } from "../../lib/id";
import type { Geocoder } from "../../providers";
import { type ParsedItem, type ParsedList, parseImportFile } from "./parse";

export interface ImportDeps {
  /** The ladder needs every result's position, so it uses the full `search`. */
  geocoder: Pick<Geocoder, "search">;
}

export interface ImportReport {
  batchId: string;
  fileName: string;
  lists: number;
  /** Every source row and Saved Places entry: placed + alreadyPresent + review + skipped. */
  rows: number;
  /** Rows materialized as new memberships this run. */
  placed: number;
  /** Rows that converged on an existing membership — a re-import, not new data. */
  alreadyPresent: number;
  /** Rows waiting in the review queue (includes geocodePending). */
  review: number;
  /** Subset of review: a geocoder error paused the geocode rung; these retry, they are not misses. */
  geocodePending: number;
  /** Rows the user skipped earlier is separate — these are unusable source rows. */
  skipped: number;
  /** Notes dropped because the deduped place already had a place post (spec/src/interop.md). */
  droppedNotes: number;
}

/** How many geocoder results a review row keeps for the candidate picker. */
const MAX_REVIEW_CANDIDATES = 5;

const originOf = (source: ImportBatch["source"]): Place["origin"] =>
  source === "mymaps-kml" ? "mymaps-kml" : "takeout";

/** Retain the row's URL as `googleUrl` only when it is a genuine https Google link. */
function retainedGoogleUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return parsePastedLink(url)?.kind === "google" ? url : undefined;
}

/** Identity of a source row — how re-imports and queue dedup recognize "the same row". */
const rawKey = (listId: string, raw: ImportItem["raw"]): string =>
  [listId, raw.title, raw.url ?? "", raw.address ?? ""].join("|");

const rawOf = (item: ParsedItem): ImportItem["raw"] => ({
  title: item.title,
  ...(item.note ? { note: item.note } : {}),
  ...(item.url ? { url: item.url } : {}),
  ...(item.address ? { address: item.address } : {}),
});

/** A paused geocode rung: still queued, but never geocoded (no candidates, no coords). */
export const isGeocodePending = (item: ImportItem): boolean =>
  item.status === "review" && item.coords === undefined && item.candidates === undefined;

export type ConflictResolution = { kind: "use-existing"; placeId: string } | { kind: "force-new" };

type Materialized =
  | { kind: "member"; membership: "added" | "already-member"; place: Place }
  | { kind: "conflict"; existing: Place };

/**
 * One membership write. The repository owns the dedup precedence; a
 * name-proximity conflict surfaces here so the caller can prompt instead of
 * merging silently (spec/src/data-model.md §Normative rules).
 */
async function materialise(
  repo: LocalRepository,
  listId: string,
  facts: NewPlaceFacts,
  now: string,
  conflict?: ConflictResolution,
): Promise<Materialized> {
  if (conflict?.kind === "use-existing") {
    const result = await repo.addToList(
      listId,
      { kind: "existing", placeId: conflict.placeId },
      { now },
    );
    if (result.status === "name-proximity-conflict")
      return { kind: "conflict", existing: result.existing };
    return { kind: "member", membership: result.status, place: result.place };
  }
  const result = await repo.addToList(
    listId,
    { kind: "new", facts },
    { now, ...(conflict?.kind === "force-new" ? { forceNew: true } : {}) },
  );
  if (result.status === "name-proximity-conflict")
    return { kind: "conflict", existing: result.existing };
  return { kind: "member", membership: result.status, place: result.place };
}

async function addExisting(
  repo: LocalRepository,
  listId: string,
  placeId: string,
  now: string,
): Promise<Materialized> {
  const result = await repo.addToList(listId, { kind: "existing", placeId }, { now });
  if (result.status === "name-proximity-conflict")
    return { kind: "conflict", existing: result.existing };
  return { kind: "member", membership: result.status, place: result.place };
}

/**
 * CSV Note → the place's own note (spec/src/interop.md §CSV Note → the
 * place's note), only while the place has none; a place that already carries
 * a different note keeps it, and the import reports the one it dropped.
 * Per-place, so it needs no import provenance: re-import changes nothing and
 * never overwrites a note edited here.
 */
export const IMPORTED_NOTE_MAX = 600;

async function importNote(
  repo: LocalRepository,
  place: Place,
  note: string | undefined,
): Promise<"created" | "dropped" | "none"> {
  const text = note?.trim().slice(0, IMPORTED_NOTE_MAX);
  if (!text) return "none";
  // Read the place fresh: an earlier row of this same file may have set it.
  const current = (await repo.getPlace(place.id))?.note;
  if (current === undefined) {
    await repo.updatePlacePersonal(place.id, { note: text });
    return "created";
  }
  return current === text ? "none" : "dropped";
}

type Point = { lat: number; lng: number };
type Decision = ReturnType<typeof autoPlaceDecision>;

function candidateKey(c: GeocoderCandidate): string {
  return c.osmRef ? `${c.osmRef.type}/${c.osmRef.id}` : `${c.name}@${c.lat},${c.lng}`;
}

/**
 * The geocode rung for one row (spec/src/interop.md §The coordinate ladder):
 * ask with title + address, leaning toward the list's placed rows, and decide.
 * A geocoder asked for a name AND an address often answers with whatever sits
 * at the address, so when that does not settle it the bare title is asked too
 * and the two answers are judged together. At most two requests per row, and
 * only one when the first settles it.
 */
async function geocodeAndDecide(
  geocoder: Pick<Geocoder, "search">,
  row: { title: string; address?: string },
  anchors: readonly Point[] = [],
): Promise<{ decision: Decision; candidates: GeocoderCandidate[] }> {
  const bias = listBias(anchors);
  const decide = (candidates: GeocoderCandidate[]) =>
    autoPlaceDecision(row, candidates, { near: anchors });
  if (!row.address) {
    const candidates = await geocoder.search(row.title, bias);
    return { decision: decide(candidates), candidates };
  }
  const joint = await geocoder.search(`${row.title}, ${row.address}`, bias);
  const first = decide(joint);
  if (first.kind === "auto") return { decision: first, candidates: joint };
  const seen = new Set(joint.map(candidateKey));
  const byTitle = (await geocoder.search(row.title, bias)).filter(
    (c) => !seen.has(candidateKey(c)),
  );
  // Title matches lead: they are the likelier picks in the review queue.
  const candidates = [...byTitle, ...joint];
  return { decision: decide(candidates), candidates };
}

/**
 * Source-list identity (spec/src/interop.md §Source-list binding): the
 * binding, then a plain name match, and only then a new list — created with
 * the nearest accent to the source colour and the binding recorded.
 */
async function targetListFor(repo: LocalRepository, list: ParsedList): Promise<List> {
  if (list.sourceKey) {
    const bound = await repo.findListBySourceKey(list.sourceKey);
    if (bound) return bound;
  }
  const byName = await repo.findListByName(list.name);
  if (byName) {
    // First import into a pre-existing list still records the binding, so
    // re-imports follow the list through later renames.
    if (list.sourceKey && byName.sourceKey === undefined) {
      await repo.setListSourceKey(byName.id, list.sourceKey);
    }
    return byName;
  }
  return repo.createList(list.name, {
    ...(list.color ? { preferColor: list.color } : {}),
    ...(list.sourceKey ? { sourceKey: list.sourceKey } : {}),
  });
}

async function closeBatchIfDone(repo: LocalRepository, batchId: string): Promise<void> {
  const items = await repo.itemsOf(batchId);
  if (items.some((i) => i.status === "review")) return;
  const batch = await repo.getImportBatch(batchId);
  if (batch?.status === "reviewing") await repo.setBatchStatus(batchId, "done");
}

type RowOutcome =
  | { kind: "member"; membership: "added" | "already-member"; place: Place }
  | { kind: "review"; candidates?: GeocoderCandidate[] }
  | { kind: "pending" };

export async function runImport(
  repo: LocalRepository,
  file: { name: string; bytes: Uint8Array },
  deps: ImportDeps,
  now: string,
): Promise<ImportReport> {
  const parsed = await parseImportFile(file);
  const batch: ImportBatch = {
    id: newId(),
    source: parsed.source,
    fileName: file.name,
    startedAt: now,
    status: "reviewing",
  };
  await repo.createImportBatch(batch);
  const origin = originOf(parsed.source);

  // Prior batches feed convergence: a source row placed before converges to
  // its place without re-running the ladder, and identical still-pending rows
  // must not pile up across re-imports.
  const placedByKey = new Map<string, string>();
  const pendingByKey = new Map<string, ImportItem>();
  for (const prior of await repo.listImportBatches()) {
    if (prior.id === batch.id) continue;
    for (const item of await repo.itemsOf(prior.id)) {
      const key = rawKey(item.targetListId, item.raw);
      if (item.status === "placed" && item.placeId) placedByKey.set(key, item.placeId);
      if (item.status === "review") pendingByKey.set(key, item);
    }
  }

  const report: ImportReport = {
    batchId: batch.id,
    fileName: file.name,
    lists: 0,
    rows: 0,
    placed: 0,
    alreadyPresent: 0,
    review: 0,
    geocodePending: 0,
    skipped: 0,
    droppedNotes: 0,
  };

  const newItems: ImportItem[] = [];
  const newItemIds = new Set<string>();
  const touchedBatches = new Set<string>();
  let geocoderDown = false;

  // Where each list's rows already are: what a coordinate-less row is
  // geocoded toward, and the evidence that picks one of several same-named
  // results (spec/src/interop.md §The coordinate ladder).
  const anchorsByList = new Map<string, Point[]>();
  const anchorsOf = (listId: string): Point[] => {
    let anchors = anchorsByList.get(listId);
    if (!anchors) {
      anchors = [];
      anchorsByList.set(listId, anchors);
    }
    return anchors;
  };

  const placeRow = async (targetListId: string, item: ParsedItem): Promise<RowOutcome> => {
    const key = rawKey(targetListId, rawOf(item));
    const googleUrl = retainedGoogleUrl(item.url);
    // Convergence first: a Google feature id already in the library, or this
    // exact source row placed by an earlier import.
    const fid = item.url ? googleFeatureId(item.url) : undefined;
    if (fid) {
      const known = await repo.findByGoogleFeatureId(fid);
      if (known) {
        const outcome = await addExisting(repo, targetListId, known.id, now);
        if (outcome.kind === "member") return outcome;
      }
    }
    const priorPlaceId = placedByKey.get(key);
    if (priorPlaceId && (await repo.getPlace(priorPlaceId))) {
      const outcome = await addExisting(repo, targetListId, priorPlaceId, now);
      if (outcome.kind === "member") return outcome;
    }
    // Rungs 1–2: literal dropped-pin coordinates, or coordinates joined from
    // the archive's GeoJSON by feature id (both arrive as item.coords).
    if (item.coords) {
      const outcome = await materialise(
        repo,
        targetListId,
        {
          name: item.title,
          lat: item.coords.lat,
          lng: item.coords.lng,
          ...(item.address ? { address: item.address } : {}),
          origin,
          ...(googleUrl ? { googleUrl } : {}),
        },
        now,
      );
      // Prompting mid-batch is impossible: the conflict waits in review.
      return outcome.kind === "member" ? outcome : { kind: "review" };
    }
    // Rung 3: geocode. A geocoder ERROR is not a miss — it pauses the rung for
    // the batch's remaining rows; only genuine empty results fall to review.
    if (geocoderDown) return { kind: "pending" };
    let candidates: GeocoderCandidate[];
    let decision: Decision;
    try {
      ({ candidates, decision } = await geocodeAndDecide(
        deps.geocoder,
        { title: item.title, ...(item.address ? { address: item.address } : {}) },
        anchorsOf(targetListId),
      ));
    } catch {
      geocoderDown = true;
      return { kind: "pending" };
    }
    if (decision.kind === "review") {
      return { kind: "review", candidates: candidates.slice(0, MAX_REVIEW_CANDIDATES) };
    }
    // Geocoder results are OSM data: auto-placement records the osmRef.
    const c = decision.candidate;
    anchorsOf(targetListId).push({ lat: c.lat, lng: c.lng });
    const outcome = await materialise(
      repo,
      targetListId,
      {
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        ...(c.address ? { address: c.address } : {}),
        origin,
        ...(googleUrl ? { googleUrl } : {}),
        ...(c.osmRef ? { osmRef: c.osmRef } : {}),
      },
      now,
    );
    return outcome.kind === "member" ? outcome : { kind: "review", candidates: [c] };
  };

  for (const list of parsed.lists) {
    report.lists += 1;
    // A list holding only unusable rows is bookkeeping, not a real list.
    const target = list.items.length > 0 ? await targetListFor(repo, list) : undefined;
    const targetListId = target?.id ?? "";

    for (const raw of list.unusable) {
      // Unusable source rows are persisted, not just counted — no silent drops.
      newItems.push({
        id: newId(),
        batchId: batch.id,
        targetListId,
        raw: {
          title: raw.title,
          ...(raw.note ? { note: raw.note } : {}),
          ...(raw.url ? { url: raw.url } : {}),
          ...(raw.address ? { address: raw.address } : {}),
        },
        status: "skipped",
      });
      report.rows += 1;
      report.skipped += 1;
    }

    // Seed the list's anchors: places it already holds, and every row of this
    // file that carries its own coordinates.
    if (target) {
      const anchors = anchorsOf(target.id);
      for (const { place } of await repo.entriesOf(target.id)) {
        anchors.push({ lat: place.lat, lng: place.lng });
      }
      for (const item of list.items) if (item.coords) anchors.push(item.coords);
    }

    for (const item of list.items) {
      report.rows += 1;
      const row: ImportItem = {
        id: newId(),
        batchId: batch.id,
        targetListId,
        raw: rawOf(item),
        ...(item.coords ? { coords: item.coords } : {}),
        status: "review",
      };
      const key = rawKey(targetListId, row.raw);
      const outcome = await placeRow(targetListId, item);

      if (outcome.kind === "member") {
        row.status = "placed";
        row.placeId = outcome.place.id;
        row.coords ??= { lat: outcome.place.lat, lng: outcome.place.lng };
        if (outcome.membership === "added") report.placed += 1;
        else report.alreadyPresent += 1;
        if ((await importNote(repo, outcome.place, item.note)) === "dropped") {
          report.droppedNotes += 1;
        }
        newItems.push(row);
        newItemIds.add(row.id);
        // A resolved row supersedes any identical still-pending review row.
        const stale = pendingByKey.get(key);
        if (stale && !newItemIds.has(stale.id)) {
          pendingByKey.delete(key);
          await repo.updateImportItem({ ...stale, status: "placed", placeId: outcome.place.id });
          touchedBatches.add(stale.batchId);
        }
        continue;
      }

      // review or pending — both wait in the queue; pending rows additionally
      // retry the geocode rung via resumeImport.
      if (outcome.kind === "review" && outcome.candidates) row.candidates = outcome.candidates;
      report.review += 1;
      if (outcome.kind === "pending") report.geocodePending += 1;

      const stale = pendingByKey.get(key);
      if (!stale) {
        pendingByKey.set(key, row);
        newItems.push(row);
        newItemIds.add(row.id);
      } else if (newItemIds.has(stale.id)) {
        // The same row twice in one archive: fold into the first queue entry.
        stale.raw = row.raw;
        if (row.coords) stale.coords = row.coords;
        if (row.candidates) stale.candidates = row.candidates;
      } else {
        // An identical row already pending from an earlier import moves to
        // this batch — no queue duplication, newer source metadata wins.
        const adopted: ImportItem = {
          ...stale,
          batchId: batch.id,
          raw: row.raw,
          ...(row.coords ? { coords: row.coords } : {}),
          ...(row.candidates ? { candidates: row.candidates } : {}),
        };
        await repo.updateImportItem(adopted);
        pendingByKey.set(key, adopted);
        touchedBatches.add(stale.batchId);
      }
    }
  }

  await repo.putImportItems(newItems);
  for (const batchId of touchedBatches) {
    if (batchId !== batch.id) await closeBatchIfDone(repo, batchId);
  }
  if (report.review === 0) await repo.setBatchStatus(batch.id, "done");
  return report;
}

export interface ResumeReport {
  placed: number;
  alreadyPresent: number;
  review: number;
  geocodePending: number;
  droppedNotes: number;
}

/**
 * Retry the paused geocode rung of every reviewing batch — the rows a geocoder
 * error left ungeocoded. Another error pauses again; nothing is consumed.
 */
export async function resumeImport(
  repo: LocalRepository,
  deps: ImportDeps,
  now: string,
): Promise<ResumeReport> {
  const report: ResumeReport = {
    placed: 0,
    alreadyPresent: 0,
    review: 0,
    geocodePending: 0,
    droppedNotes: 0,
  };
  let geocoderDown = false;
  const anchorCache = new Map<string, Point[]>();
  const listAnchors = async (listId: string): Promise<Point[]> => {
    let anchors = anchorCache.get(listId);
    if (!anchors) {
      anchors = (await repo.entriesOf(listId)).map(({ place }) => ({
        lat: place.lat,
        lng: place.lng,
      }));
      anchorCache.set(listId, anchors);
    }
    return anchors;
  };
  const batches = (await repo.listImportBatches()).filter((b) => b.status === "reviewing");
  for (const batch of batches) {
    const origin = originOf(batch.source);
    for (const item of await repo.itemsOf(batch.id)) {
      if (!isGeocodePending(item)) continue;
      if (geocoderDown) {
        report.geocodePending += 1;
        continue;
      }
      let candidates: GeocoderCandidate[];
      let decision: Decision;
      try {
        ({ candidates, decision } = await geocodeAndDecide(
          deps.geocoder,
          item.raw,
          await listAnchors(item.targetListId),
        ));
      } catch {
        geocoderDown = true;
        report.geocodePending += 1;
        continue;
      }
      if (decision.kind === "review") {
        await repo.updateImportItem({
          ...item,
          candidates: candidates.slice(0, MAX_REVIEW_CANDIDATES),
        });
        report.review += 1;
        continue;
      }
      const c = decision.candidate;
      const googleUrl = retainedGoogleUrl(item.raw.url);
      const outcome = await materialise(
        repo,
        item.targetListId,
        {
          name: c.name,
          lat: c.lat,
          lng: c.lng,
          ...(c.address ? { address: c.address } : {}),
          origin,
          ...(googleUrl ? { googleUrl } : {}),
          ...(c.osmRef ? { osmRef: c.osmRef } : {}),
        },
        now,
      );
      if (outcome.kind === "conflict") {
        await repo.updateImportItem({ ...item, candidates: [c] });
        report.review += 1;
        continue;
      }
      await repo.updateImportItem({
        ...item,
        status: "placed",
        placeId: outcome.place.id,
        coords: { lat: outcome.place.lat, lng: outcome.place.lng },
      });
      if (outcome.membership === "added") report.placed += 1;
      else report.alreadyPresent += 1;
      if ((await importNote(repo, outcome.place, item.raw.note)) === "dropped") {
        report.droppedNotes += 1;
      }
    }
    await closeBatchIfDone(repo, batch.id);
  }
  return report;
}

export type ReviewChoice =
  | { kind: "candidate"; index: number; conflict?: ConflictResolution }
  | { kind: "coords"; lat: number; lng: number; conflict?: ConflictResolution }
  | { kind: "skip" };

export type ReviewResolution =
  | { status: "resolved"; droppedNote?: boolean }
  /** A name+proximity match prompts the user rather than merging silently. */
  | { status: "conflict"; existing: Place; reason: string }
  | { status: "pending"; reason: string }
  | { status: "ignored" };

async function findImportItem(
  repo: LocalRepository,
  itemId: string,
): Promise<{ item: ImportItem; batch: ImportBatch } | undefined> {
  for (const batch of await repo.listImportBatches()) {
    const item = (await repo.itemsOf(batch.id)).find((i) => i.id === itemId);
    if (item) return { item, batch };
  }
  return undefined;
}

/** Every review item still waiting, oldest batch first — the queue the pane renders. */
export async function listReviewItems(
  repo: LocalRepository,
): Promise<{ item: ImportItem; batch: ImportBatch }[]> {
  const out: { item: ImportItem; batch: ImportBatch }[] = [];
  const batches = (await repo.listImportBatches()).sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : 1,
  );
  for (const batch of batches) {
    if (batch.status !== "reviewing") continue;
    for (const item of await repo.itemsOf(batch.id)) {
      if (item.status === "review") out.push({ item, batch });
    }
  }
  return out;
}

/**
 * Resolve one review-queue item: pick a candidate (records its osmRef —
 * geocoder results are OSM data), place manually by clicking the map (user
 * coordinates, no osmRef), or skip.
 */
export async function resolveReviewItem(
  repo: LocalRepository,
  itemId: string,
  choice: ReviewChoice,
  now: string,
): Promise<ReviewResolution> {
  const found = await findImportItem(repo, itemId);
  if (!found || found.item.status !== "review") return { status: "ignored" };
  const { item, batch } = found;

  if (choice.kind === "skip") {
    await repo.updateImportItem({ ...item, status: "skipped" });
    await closeBatchIfDone(repo, item.batchId);
    return { status: "resolved" };
  }

  const origin = originOf(batch.source);
  const googleUrl = retainedGoogleUrl(item.raw.url);
  let facts: NewPlaceFacts;
  let coords: { lat: number; lng: number };
  if (choice.kind === "coords") {
    if (
      !Number.isFinite(choice.lat) ||
      !Number.isFinite(choice.lng) ||
      Math.abs(choice.lat) > 90 ||
      Math.abs(choice.lng) > 180
    ) {
      return {
        status: "pending",
        reason: "Coordinates out of range — latitude ±90, longitude ±180.",
      };
    }
    coords = { lat: choice.lat, lng: choice.lng };
    facts = {
      name: item.raw.title,
      lat: choice.lat,
      lng: choice.lng,
      ...(item.raw.address ? { address: item.raw.address } : {}),
      origin,
      ...(googleUrl ? { googleUrl } : {}),
    };
  } else {
    const candidate = item.candidates?.[choice.index];
    if (!candidate) {
      return {
        status: "pending",
        reason: "That candidate is no longer available. Choose another.",
      };
    }
    coords = { lat: candidate.lat, lng: candidate.lng };
    facts = {
      name: candidate.name,
      lat: candidate.lat,
      lng: candidate.lng,
      ...(candidate.address ? { address: candidate.address } : {}),
      origin,
      ...(googleUrl ? { googleUrl } : {}),
      ...(candidate.osmRef ? { osmRef: candidate.osmRef } : {}),
    };
  }

  const outcome = await materialise(repo, item.targetListId, facts, now, choice.conflict);
  if (outcome.kind === "conflict") {
    return {
      status: "conflict",
      existing: outcome.existing,
      reason: `“${outcome.existing.name}” is already in the library nearby — use it, or keep both.`,
    };
  }
  await repo.updateImportItem({ ...item, status: "placed", placeId: outcome.place.id, coords });
  const note = await importNote(repo, outcome.place, item.raw.note);
  await closeBatchIfDone(repo, item.batchId);
  return { status: "resolved", ...(note === "dropped" ? { droppedNote: true } : {}) };
}

/** Abandon a reviewing batch: remaining queue rows become explicit skips. */
export async function abandonImport(repo: LocalRepository, batchId: string): Promise<void> {
  const batch = await repo.getImportBatch(batchId);
  if (batch?.status !== "reviewing") return;
  for (const item of await repo.itemsOf(batchId)) {
    if (item.status === "review") await repo.updateImportItem({ ...item, status: "skipped" });
  }
  await repo.setBatchStatus(batchId, "abandoned");
}
