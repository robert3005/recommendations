import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const LEGACY_SCHEMA = {
  places: "id, resolutionState, updatedAt, *refKeys",
  savedPlaces: "id, placeId, updatedAt",
  tags: "id, nameNorm, updatedAt",
  tagAssignments: "id, savedPlaceId, tagId, [savedPlaceId+tagId], updatedAt",
  notes: "id, targetKey, updatedAt",
  mediaAssets: "id, updatedAt",
  mediaBlobs: "id",
  lists: "id, updatedAt",
  listBlocks: "id, listId, kind, refId, updatedAt",
  blockNoteAttachments: "id, blockId, noteId, [blockId+noteId], updatedAt",
};

describe("membership migration", () => {
  it("preserves a formerly saved place that did not belong to a list", async () => {
    const dbName = `membership-migration-${crypto.randomUUID()}`;
    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_SCHEMA);

    await legacy.table("places").put({
      id: "place-1",
      origin: "osm",
      currentOsmRef: { type: "node", id: "101" },
      currentOsmLinkedAt: "2026-07-17T00:00:00.000Z",
      osmRefHistory: [],
      resolutionState: "resolved",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      refKeys: ["node/101"],
    });
    await legacy.table("savedPlaces").put({
      id: "save-1",
      placeId: "place-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    legacy.close();

    const repo = new DexieRepository(dbName);
    try {
      await repo.db.open();

      expect(await repo.getPlace("place-1")).toBeDefined();
      expect(await repo.listIdsForPlace("place-1")).not.toHaveLength(0);
      expect((await repo.listPlaces()).map(({ place }) => place.id)).toContain("place-1");
    } finally {
      repo.db.close();
      await Dexie.delete(dbName);
    }
  });
});
