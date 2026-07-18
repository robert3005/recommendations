/** Backup/restore roundtrip, merge semantics, and validation (book/src/storage-sync.md). */
import type { ResolvedPoi } from "@placemarks/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T13:00:00.000Z";

let counter = 0;
function freshRepo(): DexieRepository {
  counter += 1;
  return new DexieRepository(`backup-test-${Date.now()}-${counter}`);
}

function poi(id: string): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name: `Place ${id}`,
    category: "cafe",
    lat: 38.7,
    lng: -9.1,
    identityTags: { name: `Place ${id}` },
    resolvedAt: NOW,
  };
}

async function seed(repo: DexieRepository) {
  const view = await repo.savePoi(poi("101"), NOW);
  await repo.assignTag(view.savedPlace.id, "coffee", NOW);
  await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
  await repo.addPlaceBlock("l1", view.savedPlace.id, NOW);
  await repo.addSectionBlock("l1", "## Morning", NOW);
  await repo.createNote({
    id: "n1",
    target: { kind: "place", placeId: view.place.id },
    body: "original body",
    mediaIds: [],
    shareable: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return view;
}

describe("backup roundtrip", () => {
  it("replace-imports a full export into an empty library", async () => {
    const source = freshRepo();
    await seed(source);
    const backup = await exportBackup(source, NOW);

    const target = freshRepo();
    const result = await importBackup(target, backup, "replace", LATER);
    expect(result.imported).toBeGreaterThan(0);

    const saved = await target.listSavedPlaces();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.tags.map((t) => t.name)).toEqual(["coffee"]);
    const blocks = await target.getGuideBlocks("l1");
    expect(blocks).toHaveLength(2);
    // PlaceId is preserved — backup restore is the trusted identity path.
    expect(saved[0]?.place.id).toBe((await source.listSavedPlaces())[0]?.place.id);
  });

  it("merge keeps newer records and creates note conflict copies", async () => {
    const source = freshRepo();
    const view = await seed(source);
    const backup = await exportBackup(source, NOW);

    // The target has the same note, edited LOCALLY before the (newer) import arrives.
    const target = freshRepo();
    await importBackup(target, backup, "replace", NOW);
    const local = (await target.listNotesForPlace(view.place.id))[0];
    if (!local) throw new Error("seed note missing");
    await target.updateNote({ ...local, body: "locally edited body", updatedAt: NOW });

    // Source edits the same note later and exports again.
    await source.updateNote({ ...local, body: "remotely edited body", updatedAt: LATER });
    const newerBackup = await exportBackup(source, LATER);

    const result = await importBackup(target, newerBackup, "merge", "2026-07-18T14:00:00.000Z");
    expect(result.conflictCopies).toBe(1);
    const notes = await target.listNotesForPlace(view.place.id);
    const bodies = notes.map((n) => n.body).sort();
    // Both bodies survive: the newer import wins the id, the local edit becomes a copy.
    expect(bodies).toEqual(["locally edited body", "remotely edited body"]);
  });

  it("rejects a tampered archive", async () => {
    const source = freshRepo();
    await seed(source);
    const backup = await exportBackup(source, NOW);
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(backup);
    });
    // Flip a byte inside the zip payload.
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = (bytes[mid] ?? 0) ^ 0xff;
    const target = freshRepo();
    await expect(
      importBackup(target, new Blob([bytes.slice().buffer as ArrayBuffer]), "replace", LATER),
    ).rejects.toThrow();
  });

  it("rejects a non-backup file", async () => {
    const target = freshRepo();
    await expect(
      importBackup(target, new Blob(["not a zip"]), "replace", LATER),
    ).rejects.toThrow(/not a valid backup/);
  });
});
