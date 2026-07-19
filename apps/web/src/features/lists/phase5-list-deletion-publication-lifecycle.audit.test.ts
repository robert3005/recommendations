/** Deleting a hosted list must retain a durable path to remove its public guide. */
import type { Note, Publication } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 list-deletion publication lifecycle", () => {
  it("queues revocation instead of orphaning the public page and editor credential", async () => {
    const repo = new DexieRepository(`phase5-delete-list-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Public guide",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const hosted: Publication = {
        id: "publication-1",
        target: { kind: "list", id: "list-1" },
        mode: "hosted",
        slug: "public-guide",
        credentialId: "credential-1",
        status: "published",
        localRevision: "revision-1",
        lastPublishedLocalRevision: "revision-1",
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.db.publications.put(hosted);
      await repo.db.credentials.put({
        id: "credential-1",
        token: "a".repeat(43),
        createdAt: NOW,
        updatedAt: NOW,
      });

      await repo.deleteList("list-1", LATER);

      await expect(repo.getList("list-1")).resolves.toBeUndefined();
      await expect(repo.db.publications.get(hosted.id)).resolves.toMatchObject({
        status: "revoking",
      });
      await expect(repo.db.publicationOutbox.toArray()).resolves.toContainEqual(
        expect.objectContaining({ publicationId: hosted.id, action: "revoke" }),
      );
    } finally {
      repo.db.close();
    }
  });

  it("also revokes standalone pages for list notes deleted by the cascade", async () => {
    const repo = new DexieRepository(`phase5-delete-list-note-pages-${crypto.randomUUID()}`);
    const note: Note = {
      id: "list-note-1",
      target: { kind: "list", listId: "list-1" },
      title: "Published introduction",
      body: "This page belongs to the list being deleted.",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const notePage: Publication = {
      id: "publication-note",
      target: { kind: "note", id: note.id },
      mode: "hosted",
      slug: "published-introduction",
      credentialId: "credential-note",
      status: "published",
      localRevision: "revision-1",
      lastPublishedLocalRevision: "revision-1",
      publishedRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };

    try {
      await repo.createList({
        id: "list-1",
        name: "Public guide",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createNote(note);
      await repo.db.publications.put(notePage);

      await repo.deleteList("list-1", LATER);

      await expect(repo.db.notes.get(note.id)).resolves.toMatchObject({ deleted: true });
      await expect(repo.db.publications.get(notePage.id)).resolves.toMatchObject({
        status: "revoking",
      });
      await expect(repo.db.publicationOutbox.toArray()).resolves.toContainEqual(
        expect.objectContaining({ publicationId: notePage.id, action: "revoke" }),
      );
    } finally {
      repo.db.close();
    }
  });
});
