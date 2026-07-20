/**
 * Revised-spec regression: removing a post section is the explicit deletion
 * of its owned note, so any standalone hosted note page must enter the same
 * durable revocation path as deleteNote.
 */
import { markerAt, type Publication } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T01:00:00.000Z";

describe("Phase 6/7 post-section publication teardown", () => {
  it("revokes the section note's standalone page when its block is removed", async () => {
    const repo = new DexieRepository(`post-section-revocation-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "List one",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createPost({
        id: "post-1",
        title: "Post one",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const section = await repo.addPostSection("post-1", "Published prose", NOW, "Intro");
      const [view] = await repo.getPostBlocks("post-1");
      if (!view?.sectionNote) throw new Error("section-note fixture missing");

      await repo.updateNote({ ...view.sectionNote, shareable: true, updatedAt: LATER });
      const publication: Publication = {
        id: "section-note-publication",
        target: { kind: "note", id: view.sectionNote.id },
        mode: "hosted",
        slug: "published-prose",
        credentialId: "section-note-credential",
        status: "published",
        localRevision: "note-revision-1",
        lastPublishedLocalRevision: "note-revision-1",
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: LATER,
      };
      await repo.db.publications.put(publication);

      await repo.removePostBlock(section.id, LATER);

      await expect(repo.db.notes.get(view.sectionNote.id)).resolves.toMatchObject({
        deleted: true,
      });
      await expect(repo.db.publications.get(publication.id)).resolves.toMatchObject({
        status: "revoking",
      });
      expect(await repo.db.publicationOutbox.toArray()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ publicationId: publication.id, action: "revoke" }),
        ]),
      );
    } finally {
      repo.db.close();
    }
  });
});
