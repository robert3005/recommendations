/**
 * "Add this guide to my library" (book/src/sharing.md §Public guide viewer):
 * reuse existing local places via the normal dedup ladders; create OSM-backed
 * places only from an exact resolve or a unique high-confidence recovery.
 * Unresolved OSM anchors become pending review items (the interop queue) —
 * never silently degraded into unlinked pins. Shared manual anchors import as
 * unlinked places through the import dedup rules.
 */
import { osmElementUrl, type PoiResolver } from "@placemarks/domain";
import type { SharedGuide } from "@placemarks/schemas";
import type { ImportBatchRow, ImportItemRow } from "../../data/db";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";
import { nextUnusedColor } from "../../lib/markers";
import { resolveSharedAnchor } from "./resolveShared";

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
        const probe = await repo.findImportTarget(facts);
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
        continue;
      }

      // Unresolved: a pending preview in the review queue, never a silent pin.
      // The row keeps the copied anchor (as an OSM portal URL the importer
      // resolves exactly), coordinates, and the selected shared note.
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
