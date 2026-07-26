/** Making a published note private supersedes every pending page update. */
import { markerAt, type Note, type Publication } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 note-page revocation precedence", () => {
  it("removes a failed publish job when the note becomes private", async () => {
    const repo = new DexieRepository(`phase5-note-private-precedence-${crypto.randomUUID()}`);
    const note: Note = {
      id: "note-1",
      target: { kind: "post", postId: "post-1" },
      body: "This text must come down.",
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const publication: Publication = {
      id: "publication-1",
      target: { kind: "note", id: note.id },
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
      await repo.createList({
        id: "list-1",
        name: "Notes",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createPost({
        id: "post-1",
        title: "Notes post",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
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
});
