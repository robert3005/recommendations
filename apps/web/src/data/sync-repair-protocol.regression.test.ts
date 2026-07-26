import {
  createOsmPlace,
  markerAt,
  normalizeTagName,
  type OsmElementRef,
  type ResolvedPoi,
} from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-20T10:00:00.000Z";
const EARLIER = "2026-07-20T08:00:00.000Z";
const LATER = "2026-07-20T11:00:00.000Z";

function repoFor(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`, { actorId: `${label}-actor` });
}

function poi(ref: OsmElementRef, name: string): ResolvedPoi {
  return {
    osmRef: ref,
    name,
    category: "cafe",
    lat: 51.5,
    lng: -0.12,
    identityTags: { amenity: "cafe", name },
    resolvedAt: NOW,
  };
}

describe("sync graph repair protocol regressions", () => {
  it("coalesces a transitive component across current and historical OSM refs", async () => {
    const repo = repoFor("history-component");
    try {
      for (const [index, id] of ["list-a", "list-b", "list-c"].entries()) {
        await repo.createList({
          id,
          name: id,
          marker: markerAt(index),
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      const oldNode = { type: "node" as const, id: "1" };
      const currentA = { type: "node" as const, id: "2" };
      const currentB = { type: "way" as const, id: "9" };
      const currentC = { type: "relation" as const, id: "77" };
      const sharedOld = {
        ref: oldNode,
        linkedAt: EARLIER,
        unlinkedAt: "2026-07-20T09:00:00.000Z",
        reason: "replaced" as const,
      };
      const a = {
        ...createOsmPlace("a-place", poi(currentA, "A"), NOW),
        osmRefHistory: [sharedOld],
      };
      const b = {
        ...createOsmPlace("b-place", poi(currentB, "B"), NOW),
        osmRefHistory: [sharedOld],
      };
      const c = {
        ...createOsmPlace("c-place", poi(currentC, "C"), NOW),
        // C overlaps only B's current ref, making the component transitive.
        osmRefHistory: [
          {
            ref: currentB,
            linkedAt: EARLIER,
            unlinkedAt: "2026-07-20T09:30:00.000Z",
            reason: "replaced" as const,
          },
        ],
      };
      const rows = [a, b, c];
      await repo.applyRemoteChanges([
        ...rows.map((row, index) => ({
          table: "places" as const,
          entityId: row.id,
          actorId: "remote",
          hlc: `90000000000000${index.toString()}:000000:remote`,
          version: { remote: 1 },
          row,
        })),
        ...rows.map((row, index) => ({
          table: "listBlocks" as const,
          entityId: `membership-${row.id}`,
          actorId: "remote",
          hlc: `91000000000000${index.toString()}:000000:remote`,
          version: { remote: 1 },
          row: {
            id: `membership-${row.id}`,
            listId: ["list-a", "list-b", "list-c"][index] ?? "list-a",
            rank: "a0",
            content: { type: "place" as const, placeId: row.id },
            createdAt: NOW,
            updatedAt: NOW,
          },
        })),
      ]);

      const livePlaces = await repo.listPlaces();
      expect(livePlaces).toHaveLength(1);
      expect(livePlaces[0]?.place).toMatchObject({
        id: "a-place",
        currentOsmRef: currentA,
        resolutionState: "needs-review",
      });
      const merged = livePlaces[0]?.place;
      if (!merged) throw new Error("merged place missing");
      const evidenceRefs = new Set([
        ...(merged.currentOsmRef
          ? [`${merged.currentOsmRef.type}/${merged.currentOsmRef.id}`]
          : []),
        ...merged.osmRefHistory.map((entry) => `${entry.ref.type}/${entry.ref.id}`),
      ]);
      expect(evidenceRefs).toEqual(new Set(["node/1", "node/2", "way/9", "relation/77"]));
      expect((await repo.listIdsForPlace("a-place")).sort()).toEqual([
        "list-a",
        "list-b",
        "list-c",
      ]);
      expect(await repo.db.places.get("b-place")).toMatchObject({ deleted: true });
      expect(await repo.db.places.get("c-place")).toMatchObject({ deleted: true });
    } finally {
      repo.db.close();
    }
  });

  it("recomputes tag normalization and leaves no dangling assignment or selection", async () => {
    const repo = repoFor("edge-cleanup");
    try {
      await repo.createList({
        id: "list-1",
        name: "List",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Pin", lat: 51.5, lng: -0.12 } },
          NOW,
        )
      ).place;
      await repo.applyRemoteChanges([
        {
          table: "tags",
          entityId: "tag-1",
          actorId: "remote",
          hlc: "900000000000000:000000:remote",
          version: { remote: 1 },
          row: {
            id: "tag-1",
            name: "  Café  ",
            nameNorm: "forged-index-value",
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      ]);
      expect(await repo.db.tags.get("tag-1")).toMatchObject({
        nameNorm: normalizeTagName("  Café  "),
      });
      await repo.assignTag(place.id, "Café", NOW);
      await repo.createPost({
        id: "post-1",
        title: "Post",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const embed = await repo.embedPlaceInPost("post-1", place.id, NOW);
      const selection = await repo.selectTagForPostBlock(embed.id, "tag-1", NOW);
      const membership = (await repo.db.listBlocks.toArray()).find(
        (row) => !row.deleted && row.kind === "place" && row.refId === place.id,
      );
      if (!membership) throw new Error("membership missing");
      const membershipRev = await repo.db.syncRevs.get(`listBlocks:${membership.id}`);
      const embedRev = await repo.db.syncRevs.get(`postBlocks:${embed.id}`);
      if (!membershipRev?.version || !embedRev?.version) throw new Error("revision missing");

      await repo.applyRemoteChanges([
        {
          table: "postBlocks",
          entityId: embed.id,
          actorId: "remote",
          hlc: "999999999999998:000000:remote",
          version: { ...embedRev.version, remote: 1 },
          row: { ...embed, deleted: true, updatedAt: LATER },
        },
        {
          table: "listBlocks",
          entityId: membership.id,
          actorId: "remote",
          hlc: "999999999999999:000000:remote",
          version: { ...membershipRev.version, remote: 1 },
          row: { ...membership, deleted: true, updatedAt: LATER },
        },
      ]);

      expect(await repo.db.places.get(place.id)).toMatchObject({ deleted: true });
      const assignment = (await repo.db.tagAssignments.toArray()).find(
        (row) => row.placeId === place.id && row.tagId === "tag-1",
      );
      expect(assignment).toMatchObject({ deleted: true });
      expect(await repo.db.blockTagSelections.get(selection.id)).toMatchObject({ deleted: true });
      const liveAssignments = (await repo.db.tagAssignments.toArray()).filter(
        (row) => !row.deleted,
      );
      const liveSelections = (await repo.db.blockTagSelections.toArray()).filter(
        (row) => !row.deleted,
      );
      expect(liveAssignments).toEqual([]);
      expect(liveSelections).toEqual([]);
    } finally {
      repo.db.close();
    }
  });
});
