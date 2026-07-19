/** Making a published note private supersedes every pending page update. */
import type { Note, Publication } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 note-page revocation precedence", () => {
  it("removes a failed publish job when the note becomes private", async () => {
    const repo = new DexieRepository(`phase5-note-private-precedence-${crypto.randomUUID()}`);
    const note: Note = {
      id: "note-1",
      target: { kind: "list", listId: "list-1" },
      body: "This text must come down.",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const publication: Publication = {
      id: "publication-1",
      target: { kind: "note", id: note.id },
      mode: "hosted",
      slug: "private-later",
      credentialId: "credential-1",
      status: "failed",
      localRevision: "note-v2",
      lastPublishedLocalRevision: "note-v1",
      publishedRevision: 1,
      lastError: "publish failed (503)",
      createdAt: NOW,
      updatedAt: NOW,
    };

    try {
      await repo.createList({ id: "list-1", name: "Notes", createdAt: NOW, updatedAt: NOW });
      await repo.createNote(note);
      await repo.db.publications.put(publication);
      await repo.db.publicationOutbox.put({
        id: "failed-publish-job",
        publicationId: publication.id,
        action: "publish",
        localRevision: publication.localRevision,
        payload: JSON.stringify({ body: note.body }),
        createdAt: NOW,
        attempts: 1,
        lastError: publication.lastError,
      });

      await repo.updateNote({ ...note, shareable: false, updatedAt: LATER });

      await expect(repo.db.publications.get(publication.id)).resolves.toMatchObject({
        status: "revoking",
      });
      const jobs = (await repo.db.publicationOutbox.toArray()).filter(
        (job) => job.publicationId === publication.id,
      );
      expect(jobs).toEqual([expect.objectContaining({ action: "revoke" })]);
    } finally {
      repo.db.close();
    }
  });

  it("dirties the old containing guide when retargeting and privacy happen together", async () => {
    const repo = new DexieRepository(`phase5-note-private-retarget-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "list-a", name: "Old guide", createdAt: NOW, updatedAt: NOW });
      await repo.createList({ id: "list-b", name: "New guide", createdAt: NOW, updatedAt: NOW });
      const oldPlace = (
        await repo.addToList(
          "list-a",
          { kind: "manual", facts: { name: "Old place", lat: 51.5, lng: -0.12 } },
          NOW,
        )
      ).place;
      const newPlace = (
        await repo.addToList(
          "list-b",
          { kind: "manual", facts: { name: "New place", lat: 51.51, lng: -0.11 } },
          NOW,
        )
      ).place;
      const oldBlock = (await repo.getGuideBlocks("list-a"))[0]?.block;
      if (!oldBlock) throw new Error("old membership block fixture missing");

      const note: Note = {
        id: "retargeted-note",
        target: { kind: "place", placeId: oldPlace.id },
        body: "Private after this move.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      await repo.attachNoteToBlock(oldBlock.id, note.id, NOW);

      const guidePublication: Publication = {
        id: "old-guide-publication",
        target: { kind: "list", id: "list-a" },
        mode: "hosted",
        slug: "old-guide",
        credentialId: "old-guide-credential",
        status: "published",
        localRevision: "guide-v1",
        lastPublishedLocalRevision: "guide-v1",
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const notePublication: Publication = {
        id: "retargeted-note-publication",
        target: { kind: "note", id: note.id },
        mode: "hosted",
        slug: "retargeted-note",
        credentialId: "note-credential",
        status: "published",
        localRevision: "note-v1",
        lastPublishedLocalRevision: "note-v1",
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.db.publications.bulkPut([guidePublication, notePublication]);

      await repo.updateNote({
        ...note,
        target: { kind: "place", placeId: newPlace.id },
        shareable: false,
        updatedAt: LATER,
      });

      await expect(repo.db.publications.get(guidePublication.id)).resolves.toMatchObject({
        status: "queued",
        localRevision: expect.not.stringMatching(guidePublication.localRevision),
      });
      await expect(repo.db.publications.get(notePublication.id)).resolves.toMatchObject({
        status: "revoking",
      });
      await expect(repo.db.publicationOutbox.toArray()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ publicationId: guidePublication.id, action: "publish" }),
          expect.objectContaining({ publicationId: notePublication.id, action: "revoke" }),
        ]),
      );
    } finally {
      repo.db.close();
    }
  });
});
