/**
 * Deleting a hosted list must retain a durable path to remove its public page
 * — and bottom-up teardown (spec/src/data-model.md §Relationships,
 * spec/src/posts.md §Bottom-up teardown) means the delete is refused, with the
 * blockers named, until the list is empty and no live post editorialises it.
 * Note pages never come down through a list cascade any more: a post's own
 * section note loses its page when the POST is deleted.
 */
import { markerAt, type Publication, TeardownRefusedError } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 list-deletion publication lifecycle", () => {
  it("refuses while populated, then queues revocation instead of orphaning the public page", async () => {
    const repo = new DexieRepository(`phase5-delete-list-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Public guide",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const member = await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Viewpoint", lat: 38.7, lng: -9.1 } },
        NOW,
      );
      const hosted: Publication = {
        id: "publication-1",
        target: { kind: "list", id: "list-1" },
        slug: "public-guide",
        credentialId: "credential-1",
        status: "published",
        lastPublishedHash: "revision-1",
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

      // Bottom-up teardown: a populated list refuses to delete and names its
      // members — nothing is torn down and the public page stays untouched.
      const refusal = await repo.deleteList("list-1", LATER).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(TeardownRefusedError);
      expect(
        (refusal as TeardownRefusedError).blockers
          .filter((b) => b.kind === "member")
          .map((b) => b.id),
      ).toEqual([member.place.id]);
      await expect(repo.getList("list-1")).resolves.toMatchObject({ id: "list-1" });
      await expect(repo.db.publications.get(hosted.id)).resolves.toMatchObject({
        status: "published",
      });

      // Emptied explicitly, the delete goes through and the public page comes
      // down durably — revocation is queued, never orphaned.
      await repo.removeAllPlaces("list-1", LATER);
      await repo.deleteList("list-1", LATER);

      await expect(repo.getList("list-1")).resolves.toBeUndefined();
      await expect(repo.db.publications.get(hosted.id)).resolves.toMatchObject({
        status: "revoking",
      });
      await expect(repo.db.publicationJobs.toArray()).resolves.toContainEqual(
        expect.objectContaining({ publicationId: hosted.id, revoke: expect.anything() }),
      );
    } finally {
      repo.db.close();
    }
  });
});
