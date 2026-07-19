/**
 * "Add this guide to my library" (book/src/sharing.md §Public guide viewer):
 * reuse existing local places via the normal dedup ladders; create OSM-backed
 * places only from an exact resolve or a unique high-confidence recovery.
 * Unresolved OSM anchors become pending review items (the interop queue) —
 * never silently degraded into unlinked pins. Shared manual anchors import as
 * unlinked places through the import dedup rules.
 */
import {
  classifyCandidates,
  osmElementUrl,
  type PoiResolver,
  type ResolvedPoi,
  refKey,
} from "@placemarks/domain";
import type { SharedGuide, SharedPlaceAnchor } from "@placemarks/schemas";
import type { ImportBatchRow, ImportItemRow } from "../../data/db";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";
import { nextUnusedColor } from "../../lib/markers";
import { evidenceFromShared, resolveSharedAnchor } from "./resolveShared";

export interface SaveSharedResult {
  listId: string;
  added: number;
  duplicates: number;
  pending: number;
  sections: number;
}

const DUPLICATE_MESSAGE = "place already in this list";

export async function saveSharedGuide(
  repo: DexieRepository,
  resolver: PoiResolver,
  guide: SharedGuide,
  now: string,
): Promise<SaveSharedResult> {
  const lists = await repo.listLists();
  const existing = lists.find((l) => l.name === guide.title);
  const listId = existing?.id ?? newId();
  if (!existing) {
    await repo.createList({
      id: listId,
      name: guide.title,
      color: nextUnusedColor(lists),
      createdAt: now,
      updatedAt: now,
    });
  }

  const result: SaveSharedResult = { listId, added: 0, duplicates: 0, pending: 0, sections: 0 };
  let batch: ImportBatchRow | undefined;

  for (const block of guide.blocks) {
    if (block.type === "section") {
      await repo.addSectionBlock(listId, block.note.body, now, block.note.title);
      result.sections += 1;
      continue;
    }

    const anchor = block.place;
    try {
      if (anchor.kind === "manual") {
        // A shared manual anchor carries no OSM claim: it may converge on an
        // existing manual/unlinked place, but never auto-matches an OSM one.
        const facts = {
          name: anchor.name,
          lat: anchor.lat,
          lng: anchor.lng,
          ...(anchor.category ? { category: anchor.category } : {}),
        };
        const probed = await repo.findImportTarget(facts);
        const probe = probed === "ambiguous" ? undefined : probed;
        const source =
          probe && !probe.currentOsmRef
            ? ({ kind: "existing", placeId: probe.id } as const)
            : ({ kind: "manual", facts } as const);
        const view = await repo.addToList(listId, source, now);
        result.added += 1;
        await importNotes(repo, view.place.id, block.notes, now);
        continue;
      }

      const resolution = await resolveSharedAnchor(resolver, anchor);
      if (resolution.state === "live" || resolution.state === "recovered") {
        const view = await repo.addToList(listId, { kind: "poi", poi: resolution.poi }, now);
        result.added += 1;
        await importNotes(repo, view.place.id, block.notes, now);
        await resolvePendingRows(repo, anchor, view.place.id);
        continue;
      }

      // Provider unavailable (or the element gone upstream): the local library
      // can still answer. An exact local binding for the shared ref — or one
      // unique local-evidence match — reuses the existing place offline.
      const local =
        (await repo.findPlaceByOsmRef(anchor.currentOsmRef)) ??
        (await uniqueLocalEvidenceMatch(repo, anchor));
      if (local) {
        const view = await repo.addToList(listId, { kind: "existing", placeId: local.id }, now);
        result.added += 1;
        await importNotes(repo, view.place.id, block.notes, now);
        await resolvePendingRows(repo, anchor, view.place.id);
        continue;
      }

      // Unresolved: a pending preview in the review queue, never a silent pin.
      // The row keeps the COMPLETE recovery envelope — both evidence epochs
      // and every selected note — plus the OSM portal URL the importer
      // resolves exactly.
      batch ??= await createBatch(repo, guide, now);
      const note = (block.notes ?? [])
        .map((n) => n.body)
        .filter(Boolean)
        .join("\n\n");
      const row: ImportItemRow = {
        id: newId(),
        batchId: batch.id,
        targetListId: listId,
        raw: {
          title: anchor.lastVerified.name ?? "Shared place",
          url: osmElementUrl(anchor.currentOsmRef),
          ...(anchor.lastVerified.address ? { address: anchor.lastVerified.address } : {}),
          ...(note ? { note } : {}),
          sharedAnchor: anchor,
          ...(block.notes ? { sharedNotes: block.notes } : {}),
        },
        coords: { lat: anchor.lastVerified.lat, lng: anchor.lastVerified.lng },
        status: "review",
      };
      await repo.db.importItems.put(row);
      result.pending += 1;
    } catch (err) {
      if (err instanceof Error && err.message === DUPLICATE_MESSAGE) {
        result.duplicates += 1;
      } else {
        throw err;
      }
    }
  }

  return result;
}

/**
 * A unique high-confidence match between the copied evidence and a local
 * OSM-linked place's own evidence — both epochs must converge on one winner
 * (mirrors the viewer's recovery rule, applied to the local library).
 */
async function uniqueLocalEvidenceMatch(
  repo: DexieRepository,
  anchor: Extract<SharedPlaceAnchor, { kind: "osm" }>,
): Promise<{ id: string } | undefined> {
  const candidates: ResolvedPoi[] = [];
  const candidatePlace = new Map<string, string>();
  for (const { place } of await repo.listPlaces()) {
    if (!place.currentOsmRef || !place.lastVerified) continue;
    const evidence = place.lastVerified;
    const candidate: ResolvedPoi = {
      osmRef: place.currentOsmRef,
      ...(evidence.osmVersion !== undefined ? { osmVersion: evidence.osmVersion } : {}),
      ...(evidence.name ? { name: evidence.name } : {}),
      category: evidence.category,
      lat: evidence.lat,
      lng: evidence.lng,
      ...(evidence.address ? { address: evidence.address } : {}),
      ...(evidence.website ? { website: evidence.website } : {}),
      identityTags: evidence.identityTags,
      resolvedAt: evidence.observedAt,
    };
    candidates.push(candidate);
    candidatePlace.set(refKey(candidate.osmRef), place.id);
  }
  if (candidates.length === 0) return undefined;
  const winners = new Set<string>();
  for (const epoch of [anchor.lastVerified, anchor.firstSeen]) {
    const classified = classifyCandidates(evidenceFromShared(epoch), candidates);
    if (classified.kind === "auto") winners.add(refKey(classified.best.candidate.osmRef));
  }
  if (winners.size !== 1) return undefined;
  const placeId = candidatePlace.get([...winners][0] ?? "");
  return placeId ? { id: placeId } : undefined;
}

/** A later successful import of the same anchor clears its pending previews. */
async function resolvePendingRows(
  repo: DexieRepository,
  anchor: Extract<SharedPlaceAnchor, { kind: "osm" }>,
  placeId: string,
): Promise<void> {
  const url = osmElementUrl(anchor.currentOsmRef);
  const stale = await repo.db.importItems
    .filter((item) => item.status === "review" && item.raw.url === url)
    .toArray();
  for (const item of stale) {
    await repo.db.importItems.put({ ...item, status: "placed", linkedOsm: true, placeId });
  }
}

async function createBatch(
  repo: DexieRepository,
  guide: SharedGuide,
  now: string,
): Promise<ImportBatchRow> {
  const batch: ImportBatchRow = {
    id: newId(),
    source: "geojson",
    fileName: `shared guide: ${guide.title}`,
    startedAt: now,
    status: "reviewing",
  };
  await repo.db.importBatches.put(batch);
  return batch;
}

async function importNotes(
  repo: DexieRepository,
  placeId: string,
  notes: { title?: string; body: string }[] | undefined,
  now: string,
): Promise<void> {
  for (const note of notes ?? []) {
    const existing = await repo.listNotesForPlace(placeId);
    if (existing.some((n) => n.body === note.body)) continue;
    await repo.createNote({
      id: newId(),
      target: { kind: "place", placeId },
      ...(note.title ? { title: note.title } : {}),
      body: note.body,
      mediaIds: [],
      shareable: false,
      createdAt: now,
      updatedAt: now,
    });
  }
}
