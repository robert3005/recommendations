/** Every local edit and its publication dirty marker are one IndexedDB commit. */
import { markerAt, type Note, type Publication } from "@placemarks/domain";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

function publication(id: string, target: Publication["target"]): Publication {
  return {
    id,
    target,
    slug: id,
    credentialId: `${id}-credential`,
    status: "published",
    localRevision: `${id}-v1`,
    lastPublishedLocalRevision: `${id}-v1`,
    publishedRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function addManual(repo: DexieRepository, name: string) {
  return repo.addToList("list-1", { kind: "manual", facts: { name, lat: 38.71, lng: -9.14 } }, NOW);
}

describe("Phase 5 additional edit/dirty atomicity", () => {
  it("rolls a block reorder back when its durable dirty marker cannot commit", async () => {
    const repo = new DexieRepository(`phase5-atomic-reorder-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Atomic reorder",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await addManual(repo, "First");
      await addManual(repo, "Second");
      const beforeBlocks = (await repo.getListBlocks("list-1")).map(({ block }) => block.id);
      const hosted = publication("publication-list", { kind: "list", id: "list-1" });
      await repo.db.publications.put(hosted);

      vi.spyOn(repo.db.publicationOutbox, "put").mockRejectedValueOnce(
        new Error("simulated dirty-marker failure"),
      );
      await expect(
        repo.moveBlock(beforeBlocks[1] ?? "", beforeBlocks[0] ?? "", LATER),
      ).rejects.toThrow(/dirty-marker/i);

      expect((await repo.getListBlocks("list-1")).map(({ block }) => block.id)).toEqual(
        beforeBlocks,
      );
      expect(await repo.db.publications.get(hosted.id)).toEqual(hosted);
      expect(await repo.db.publicationOutbox.count()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      repo.db.close();
    }
  });

  it("rolls a block removal back when its durable dirty marker cannot commit", async () => {
    const repo = new DexieRepository(`phase5-atomic-removal-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Atomic removal",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (await addManual(repo, "Must remain")).place;
      const block = (await repo.getListBlocks("list-1"))[0]?.block;
      if (!block) throw new Error("block fixture missing");
      const hosted = publication("publication-list", { kind: "list", id: "list-1" });
      await repo.db.publications.put(hosted);

      vi.spyOn(repo.db.publicationOutbox, "put").mockRejectedValueOnce(
        new Error("simulated dirty-marker failure"),
      );
      await expect(repo.removeBlock(block.id, LATER)).rejects.toThrow(/dirty-marker/i);

      expect(await repo.getListBlocks("list-1")).toHaveLength(1);
      expect(await repo.getPlace(place.id)).toBeDefined();
      expect(await repo.db.publications.get(hosted.id)).toEqual(hosted);
      expect(await repo.db.publicationOutbox.count()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      repo.db.close();
    }
  });

  it("rolls a shareable note edit and every affected publication back together", async () => {
    const repo = new DexieRepository(`phase5-atomic-note-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Atomic note",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (await addManual(repo, "Noted place")).place;
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Original",
        body: "Original body",
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      const publications = [
        publication("publication-list", { kind: "list", id: "list-1" }),
        publication("publication-note", { kind: "note", id: note.id }),
      ];
      await repo.db.publications.bulkPut(publications);

      vi.spyOn(repo.db.publicationOutbox, "put").mockRejectedValueOnce(
        new Error("simulated dirty-marker failure"),
      );
      await expect(
        repo.updateNote({
          ...note,
          title: "Uncommitted",
          body: "Uncommitted body",
          updatedAt: LATER,
        }),
      ).rejects.toThrow(/dirty-marker/i);

      expect(await repo.db.notes.get(note.id)).toMatchObject({
        title: "Original",
        body: "Original body",
      });
      for (const hosted of publications) {
        expect(await repo.db.publications.get(hosted.id)).toEqual(hosted);
      }
      expect(await repo.db.publicationOutbox.count()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      repo.db.close();
    }
  });
});
