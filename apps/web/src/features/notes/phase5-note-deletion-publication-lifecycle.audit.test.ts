/** A deleted public note must not leave unreachable public projections behind. */
import { markerAt, type Note, type Publication } from "@placemarks/domain";
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

describe("Phase 5 note-deletion publication lifecycle", () => {
  it("revokes the standalone page and dirties every containing guide when its note is deleted", async () => {
    const repo = new DexieRepository(`phase5-delete-note-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Published guide",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Shared place", lat: 51.5, lng: -0.12 } },
          NOW,
        )
      ).place;
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Public tip",
        body: "This is present in both public projections.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      const guidePublication = publication("publication-guide", {
        kind: "list",
        id: "list-1",
      });
      const notePublication = publication("publication-note", { kind: "note", id: note.id });
      await repo.db.publications.bulkPut([guidePublication, notePublication]);

      await repo.deleteNote(note.id, LATER);

      await expect(repo.db.notes.get(note.id)).resolves.toMatchObject({ deleted: true });
      await expect(repo.db.publications.get(notePublication.id)).resolves.toMatchObject({
        status: "revoking",
      });
      await expect(repo.db.publications.get(guidePublication.id)).resolves.toMatchObject({
        status: "queued",
        localRevision: expect.not.stringMatching(guidePublication.localRevision),
      });
      const jobs = await repo.db.publicationOutbox.toArray();
      expect(jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ publicationId: notePublication.id, action: "revoke" }),
          expect.objectContaining({ publicationId: guidePublication.id, action: "publish" }),
        ]),
      );
    } finally {
      repo.db.close();
    }
  });
});
