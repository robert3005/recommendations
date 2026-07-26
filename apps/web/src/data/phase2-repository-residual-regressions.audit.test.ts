/**
 * Residual repository-boundary regressions found while auditing Phase 2 at
 * 15c3d8e. These assertions permit refusal or normalization, but never a
 * malformed durable identity or a deletion that bypasses its cascade.
 */
import { linkPlaceToOsm, markerAt, type Note, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

// Live list markers are unique pairs — each fixture list takes the next one.
let markerCounter = 0;

function poi(id: string, resolvedAt = NOW): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name: `Place ${id}`,
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: `Place ${id}`, amenity: "cafe" },
    resolvedAt,
  };
}

async function seedOsm(repo: DexieRepository, listId = "list-1") {
  markerCounter += 1;
  await repo.createList({
    id: listId,
    name: listId,
    marker: markerAt(markerCounter - 1),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return (await repo.addToList(listId, { kind: "poi", poi: poi("101") }, NOW)).place;
}

async function seedManual(repo: DexieRepository, listId: string, name: string) {
  markerCounter += 1;
  await repo.createList({
    id: listId,
    name: listId,
    marker: markerAt(markerCounter - 1),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return (
    await repo.addToList(
      listId,
      { kind: "manual", facts: { name, lat: 38.7139, lng: -9.1394 } },
      NOW,
    )
  ).place;
}

describe("Phase 2 residual durable-identity boundaries", () => {
  it("does not accept arbitrary extra history entries around a real relink interval", async () => {
    const repo = freshRepo("phase2-residual-history-tail");
    try {
      const original = await seedOsm(repo);
      const canonical = linkPlaceToOsm(original, poi("202", LATER), LATER, "owner-confirmed");
      const forged = {
        ...canonical,
        pastOsmRefs: [{ type: "way" as const, id: "999" }],
      };

      await repo.updatePlace(forged).catch(() => undefined);

      const stored = await repo.getPlace(original.id);
      if (!stored) throw new Error("place fixture disappeared");
      if (stored.currentOsmRef?.id === canonical.currentOsmRef?.id) {
        // Normalizing to the one domain-produced interval is valid.
        expect(stored.pastOsmRefs).toEqual(canonical.pastOsmRefs);
      } else {
        // Refusing the whole transition is also valid.
        expect(stored).toMatchObject({
          currentOsmRef: original.currentOsmRef,
          pastOsmRefs: original.pastOsmRefs,
        });
      }
    } finally {
      repo.db.close();
    }
  });

  it("never turns an OSM-origin place into an unlinked place", async () => {
    const repo = freshRepo("phase2-residual-osm-unlink");
    try {
      const original = await seedOsm(repo);
      if (!original.currentOsmRef || !original.currentOsmLinkedAt) {
        throw new Error("OSM fixture has no binding");
      }

      await repo
        .updatePlace({
          ...original,
          currentOsmRef: undefined,
          currentOsmLinkedAt: undefined,
          pastOsmRefs: [],
          resolutionState: "unlinked",
          updatedAt: LATER,
        })
        .catch(() => undefined);

      const stored = await repo.getPlace(original.id);
      expect(stored).toMatchObject({
        origin: "osm",
        currentOsmRef: original.currentOsmRef,
      });
    } finally {
      repo.db.close();
    }
  });

  it("applies the exact-ref fork guard when importer linkage upgrades two places concurrently", async () => {
    const repo = freshRepo("phase2-residual-import-link-fork");
    try {
      const first = await seedManual(repo, "list-a", "First pin");
      const second = await seedManual(repo, "list-b", "Second pin");
      const match = poi("404", LATER);

      await Promise.allSettled([
        repo.linkImportedPlace(first, match, LATER),
        repo.linkImportedPlace(second, match, LATER),
      ]);

      const holders = (await repo.listPlaces()).filter(
        ({ place }) => place.currentOsmRef?.type === "node" && place.currentOsmRef.id === "404",
      );
      expect(holders).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 2 residual whole-object update boundaries", () => {
  it("does not let updatePlace tombstone a place while leaving its membership live", async () => {
    const repo = freshRepo("phase2-residual-update-place-delete");
    try {
      const place = await seedManual(repo, "list-1", "Manual pin");

      await repo.updatePlace({ ...place, deleted: true, updatedAt: LATER }).catch(() => undefined);

      await expect(repo.getPlace(place.id)).resolves.toBeDefined();
      const liveMembership = (await repo.db.listBlocks.toArray()).find(
        (block) => !block.deleted && block.kind === "place" && block.refId === place.id,
      );
      expect(liveMembership).toBeDefined();
    } finally {
      repo.db.close();
    }
  });

  it("does not let updateNote tombstone a note outside deleteNote's cascade", async () => {
    const repo = freshRepo("phase2-residual-update-note-delete");
    try {
      const place = await seedManual(repo, "list-1", "Manual pin");
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "Keep me",
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      await repo.updateNote({ ...note, deleted: true, updatedAt: LATER }).catch(() => undefined);

      expect((await repo.db.notes.get(note.id))?.deleted).not.toBe(true);
    } finally {
      repo.db.close();
    }
  });
});
