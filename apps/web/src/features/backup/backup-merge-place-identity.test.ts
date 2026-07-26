/**
 * Revised-spec regression: identity-aware backup merge must rewrite every
 * edge that carries a PlaceId, including post embeds. Dropping a duplicate
 * place while retaining an embed to its old id breaks both the post and the
 * embed-is-a-list-member invariant.
 */
import { markerAt, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T01:00:00.000Z";

const POI: ResolvedPoi = {
  osmRef: { type: "node", id: "4242" },
  name: "The same café",
  category: "cafe",
  lat: 51.5,
  lng: -0.12,
  identityTags: { name: "The same café", amenity: "cafe" },
  resolvedAt: NOW,
};

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

describe("Phase 6/7 post identity merge", () => {
  it("retargets an imported post embed to the retained exact-OSM place", async () => {
    const local = freshRepo("post-identity-local");
    const incoming = freshRepo("post-identity-incoming");
    try {
      await local.createList({
        id: "local-list",
        name: "Local",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const retained = await local.addToList("local-list", { kind: "poi", poi: POI }, NOW);

      await incoming.createList({
        id: "incoming-list",
        name: "Incoming",
        marker: markerAt(1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const duplicate = await incoming.addToList("incoming-list", { kind: "poi", poi: POI }, NOW);
      await incoming.createPost({
        id: "incoming-post",
        title: "A post about the café",
        listId: "incoming-list",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await incoming.embedPlaceInPost("incoming-post", duplicate.place.id, NOW);

      await importBackup(local, await exportBackup(incoming, NOW), "merge", LATER);

      expect(await local.listPlaces()).toHaveLength(1);
      expect(await local.listIdsForPlace(retained.place.id)).toEqual(
        expect.arrayContaining(["local-list", "incoming-list"]),
      );
      const [embed] = await local.getPostBlocks("incoming-post");
      expect(embed?.block.content).toEqual({ type: "place", placeId: retained.place.id });
      expect(embed?.place?.id).toBe(retained.place.id);
    } finally {
      local.db.close();
      incoming.db.close();
    }
  });

  it("coalesces two same-post embeds that become the same place after identity remapping", async () => {
    const local = freshRepo("post-embed-coalesce-local");
    const incoming = freshRepo("post-embed-coalesce-incoming");
    try {
      for (const repo of [local, incoming]) {
        await repo.createList({
          id: "shared-list",
          name: "Shared list",
          marker: markerAt(0),
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      const retained = await local.addToList("shared-list", { kind: "poi", poi: POI }, NOW);
      const duplicate = await incoming.addToList("shared-list", { kind: "poi", poi: POI }, NOW);
      for (const repo of [local, incoming]) {
        await repo.createPost({
          id: "shared-post",
          title: "Shared post",
          listId: "shared-list",
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      await local.embedPlaceInPost("shared-post", retained.place.id, NOW);
      await incoming.embedPlaceInPost("shared-post", duplicate.place.id, NOW);

      await importBackup(local, await exportBackup(incoming, NOW), "merge", LATER);

      expect(await local.listPlaces()).toHaveLength(1);
      expect(await local.getListBlocks("shared-list")).toHaveLength(1);
      const embeds = await local.getPostBlocks("shared-post");
      expect(embeds).toHaveLength(1);
      expect(embeds[0]?.block.content).toEqual({
        type: "place",
        placeId: retained.place.id,
      });
    } finally {
      local.db.close();
      incoming.db.close();
    }
  });
});
