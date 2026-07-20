/**
 * Revised-spec regression: marker uniqueness is a final-graph invariant.
 * A merge may contain a valid archive and a valid local library which become
 * invalid only when combined, so validating each side independently is not
 * sufficient (spec/src/data-model.md — every live list marker is unique).
 */
import { markerAt, markerKey } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T01:00:00.000Z";

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

async function seedList(repo: DexieRepository, id: string): Promise<void> {
  await repo.createList({
    id,
    name: id,
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.addToList(
    id,
    {
      kind: "manual",
      facts: { name: `${id} place`, lat: 51.5, lng: -0.12 },
    },
    NOW,
  );
}

describe("Phase 6/7 backup marker invariants", () => {
  it("never commits a final graph whose live lists share a marker", async () => {
    const local = freshRepo("marker-merge-local");
    const incoming = freshRepo("marker-merge-incoming");
    try {
      await seedList(local, "local-list");
      await seedList(incoming, "incoming-list");
      const archive = await exportBackup(incoming, NOW);

      let rejected = false;
      try {
        await importBackup(local, archive, "merge", LATER);
      } catch (error) {
        rejected = true;
        expect(error).toBeInstanceOf(Error);
      }

      const lists = await local.listLists();
      if (rejected) {
        // Refusal is atomic: a failed import leaves the local graph untouched.
        expect(lists.map((list) => list.id)).toEqual(["local-list"]);
      } else {
        // Deterministically assigning the incoming list another unused marker
        // is also spec-compliant; committing a duplicate pair is not.
        expect(lists.map((list) => list.id).sort()).toEqual(["incoming-list", "local-list"]);
        expect(new Set(lists.map((list) => markerKey(list.marker))).size).toBe(lists.length);
      }
    } finally {
      local.db.close();
      incoming.db.close();
    }
  });
});
