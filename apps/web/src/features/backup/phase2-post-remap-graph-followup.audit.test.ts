/**
 * Identity coalescing rewrites PlaceIds during backup merge. The graph that is
 * actually committed after that rewrite must still satisfy the same edge
 * invariants that were validated before the transaction.
 */
import { markerAt, type Note, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

function repoFor(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

const poi: ResolvedPoi = {
  osmRef: { type: "node", id: "101" },
  name: "Café Central",
  category: "cafe",
  lat: 38.7139,
  lng: -9.1394,
  identityTags: { amenity: "cafe", name: "Café Central" },
  resolvedAt: NOW,
};

// Live list markers are unique (colour, icon) pairs; a counter keeps fixture
// lists distinct even across merged libraries.
let markerCounter = 0;

async function seedMembership(repo: DexieRepository): Promise<{
  placeId: string;
  blockId: string;
}> {
  await repo.createList({
    id: "shared-list",
    name: "Trip",
    marker: markerAt(markerCounter++),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const place = (await repo.addToList("shared-list", { kind: "poi", poi }, NOW)).place;
  const block = (await repo.getListBlocks("shared-list"))[0]?.block;
  if (!block) throw new Error("membership block fixture is missing");
  return { placeId: place.id, blockId: block.id };
}

describe("Phase 2 post-coalescing backup graph", () => {
  it("dedupes a skipped duplicate membership onto the retained block and retargets its notes", async () => {
    const source = repoFor("phase2-remap-membership-source");
    const target = repoFor("phase2-remap-membership-target");
    try {
      const sourceMembership = await seedMembership(source);
      const retainedMembership = await seedMembership(target);
      const note: Note = {
        id: "source-note",
        target: { kind: "place", placeId: sourceMembership.placeId },
        body: "Attached source prose",
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await source.createNote(note);

      await expect(
        importBackup(target, await exportBackup(source, NOW), "merge", LATER),
      ).resolves.toMatchObject({ mode: "merge" });

      const liveMemberships = (await target.db.listBlocks.toArray()).filter(
        (block) => !block.deleted && block.kind === "place" && block.listId === "shared-list",
      );
      expect(liveMemberships).toHaveLength(1);
      expect(liveMemberships[0]).toMatchObject({
        id: retainedMembership.blockId,
        refId: retainedMembership.placeId,
      });
      await expect(target.db.listBlocks.get(sourceMembership.blockId)).resolves.toBeUndefined();
      await expect(target.db.notes.get(note.id)).resolves.toMatchObject({
        target: { kind: "place", placeId: retainedMembership.placeId },
        targetKey: `place:${retainedMembership.placeId}`,
      });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a restored post attachment to a private note", async () => {
    const source = repoFor("phase2-private-attachment-source");
    const target = repoFor("phase2-private-attachment-target");
    try {
      const membership = await seedMembership(source);
      const note: Note = {
        id: "private-source-note",
        target: { kind: "place", placeId: membership.placeId },
        body: "Private prose",
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await source.createNote(note);
      await source.createPost({
        id: "trip-post",
        title: "Trip",
        listId: "shared-list",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const embed = await source.embedPlaceInPost("trip-post", membership.placeId, NOW);
      // Construct an archive that is structurally well-formed but violates the
      // authoritative eligibility invariant. Public repository APIs correctly
      // refuse this edge; restore must enforce the same rule.
      await source.db.blockNoteAttachments.put({
        id: "private-edge",
        blockId: embed.id,
        noteId: note.id,
        rank: "a",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await target.createList({
        id: "sentinel-list",
        name: "Keep on rejection",
        marker: markerAt(markerCounter++),
        createdAt: NOW,
        updatedAt: NOW,
      });

      await expect(
        importBackup(target, await exportBackup(source, NOW), "replace", LATER),
      ).rejects.toThrow(/shareable|private|attachment|graph/i);
      expect((await target.listLists()).map((list) => list.id)).toEqual(["sentinel-list"]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
