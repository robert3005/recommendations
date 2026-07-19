/** Revocation state and its durable DELETE job must commit as one local transition. */
import type { Publication } from "@placemarks/domain";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { revokePublication } from "./publication";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 revocation scheduling atomicity", () => {
  it("keeps the prior state and publish marker when the revoke job cannot be persisted", async () => {
    const repo = new DexieRepository(`phase5-atomic-revoke-${crypto.randomUUID()}`);
    const publication: Publication = {
      id: "publication-1",
      target: { kind: "list", id: "list-1" },
      mode: "hosted",
      slug: "published-guide",
      credentialId: "credential-1",
      status: "queued",
      localRevision: "local-v2",
      lastPublishedLocalRevision: "local-v1",
      publishedRevision: 1,
      createdAt: NOW,
      updatedAt: LATER,
    };
    const publishJob = {
      id: "publish-job-1",
      publicationId: publication.id,
      action: "publish" as const,
      localRevision: publication.localRevision,
      createdAt: LATER,
      attempts: 0,
    };

    try {
      await repo.db.publications.put(publication);
      await repo.db.publicationOutbox.put(publishJob);
      vi.spyOn(repo.db.publicationOutbox, "put").mockRejectedValueOnce(
        new Error("simulated revoke-job persistence failure"),
      );
      const fetcher: typeof fetch = async () => {
        throw new Error("network must not run without a durable revoke job");
      };

      await expect(revokePublication(repo, publication.id, LATER, fetcher)).rejects.toThrow(
        /revoke-job persistence failure/i,
      );

      await expect(repo.db.publications.get(publication.id)).resolves.toEqual(publication);
      await expect(repo.db.publicationOutbox.toArray()).resolves.toEqual([publishJob]);
    } finally {
      vi.restoreAllMocks();
      repo.db.close();
    }
  });
});
