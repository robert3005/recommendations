/** Removing a place must update every public projection that contained it. */
import type { Note, Publication } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

function publication(id: string, target: Publication["target"]): Publication {
  return {
    id,
    target,
    mode: "hosted",
    slug: id,
    credentialId: `${id}-credential`,
    status: "published",
    localRevision: `${id}-revision-1`,
    lastPublishedLocalRevision: `${id}-revision-1`,
    publishedRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Phase 5 place-deletion publication lifecycle", () => {
  it("dirties every containing guide and revokes standalone pages for deleted place notes", async () => {
    const repo = new DexieRepository(`phase5-delete-place-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "list-1", name: "First guide", createdAt: NOW, updatedAt: NOW });
      await repo.createList({ id: "list-2", name: "Second guide", createdAt: NOW, updatedAt: NOW });
      const place = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Shared place", lat: 51.5, lng: -0.12 } },
          NOW,
        )
      ).place;
      await repo.addToList("list-2", { kind: "existing", placeId: place.id }, NOW);
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "A separately published place note.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      const firstGuide = publication("publication-guide-1", { kind: "list", id: "list-1" });
      const secondGuide = publication("publication-guide-2", { kind: "list", id: "list-2" });
      const notePage = publication("publication-note", { kind: "note", id: note.id });
      await repo.db.publications.bulkPut([firstGuide, secondGuide, notePage]);

      await repo.removePlace(place.id, LATER);

      await expect(repo.getPlace(place.id)).resolves.toBeUndefined();
      await expect(repo.db.notes.get(note.id)).resolves.toMatchObject({ deleted: true });
      for (const guide of [firstGuide, secondGuide]) {
        await expect(repo.db.publications.get(guide.id)).resolves.toMatchObject({
          status: "queued",
          localRevision: expect.not.stringMatching(guide.localRevision),
        });
      }
      await expect(repo.db.publications.get(notePage.id)).resolves.toMatchObject({
        status: "revoking",
      });
      const jobs = await repo.db.publicationOutbox.toArray();
      expect(jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ publicationId: firstGuide.id, action: "publish" }),
          expect.objectContaining({ publicationId: secondGuide.id, action: "publish" }),
          expect.objectContaining({ publicationId: notePage.id, action: "revoke" }),
        ]),
      );
    } finally {
      repo.db.close();
    }
  });
});
