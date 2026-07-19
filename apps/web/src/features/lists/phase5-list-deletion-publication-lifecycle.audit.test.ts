/** Deleting a hosted list must retain a durable path to remove its public guide. */
import type { Publication } from "@placemarks/domain";
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
});
