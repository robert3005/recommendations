/**
 * Phase 5 client publication (spec/src/sharing.md §Local publication record):
 * token generated and persisted before any request; durable jobs retry after
 * failure without rolling the public document back; publish/update/revoke walk
 * the queued→publishing→published / revoking→revoked state machine against the
 * real service protocol.
 */
import type { ResolvedPoi } from "@placemarks/domain";
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import {
  publicationForList,
  publishList,
  revokePublication,
  runPublicationOutbox,
} from "./publication";

const NOW = "2026-07-19T16:00:00.000Z";

function poi(): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: "Café Central" },
    resolvedAt: NOW,
  };
}

async function seeded(): Promise<DexieRepository> {
  const repo = new DexieRepository(`publish-${crypto.randomUUID()}`);
  await repo.createList({ id: "list-1", name: "Lisbon Weekend", createdAt: NOW, updatedAt: NOW });
  await repo.addToList("list-1", { kind: "poi", poi: poi() }, NOW);
  return repo;
}

function serviceFetcher(storage = new MemoryStorage()) {
  const app = createShareApp({ storage });
  const fetcher: typeof fetch = async (input, init) =>
    app.request(new URL(String(input), "https://share.test").toString(), init);
  return { fetcher, storage };
}

describe("hosted publication", () => {
  it("publishes: token persisted first, slug from the name, published state + revision", async () => {
    const repo = await seeded();
    const { fetcher, storage } = serviceFetcher();
    try {
      await publishList(repo, "list-1", NOW, fetcher);

      const publication = await publicationForList(repo, "list-1");
      expect(publication).toMatchObject({
        status: "published",
        slug: "lisbon-weekend",
        publishedRevision: 1,
      });
      expect(publication?.lastPublishedLocalRevision).toBe(publication?.localRevision);

      const credential = publication?.credentialId
        ? await repo.db.credentials.get(publication.credentialId)
        : undefined;
      expect(credential?.token.length ?? 0).toBeGreaterThanOrEqual(43);
      // The server holds only a hash of it.
      const stored = await storage.get("list", "lisbon-weekend");
      expect(stored?.tokenHash).not.toContain(credential?.token);
      expect(await repo.db.publicationOutbox.count()).toBe(0);
    } finally {
      repo.db.close();
    }
  });

  it("updates conditionally and never rolls back; revoke tombstones", async () => {
    const repo = await seeded();
    const { fetcher, storage } = serviceFetcher();
    try {
      await publishList(repo, "list-1", NOW, fetcher);

      // A content change → new local revision → queued update → revision 2.
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Picnic bench", lat: 38.72, lng: -9.15 } },
        NOW,
      );
      await publishList(repo, "list-1", "2026-07-19T17:00:00.000Z", fetcher);
      let publication = await publicationForList(repo, "list-1");
      expect(publication).toMatchObject({ status: "published", publishedRevision: 2 });

      await revokePublication(repo, publication?.id ?? "", "2026-07-19T18:00:00.000Z", fetcher);
      publication = await publicationForList(repo, "list-1");
      expect(publication?.status).toBe("revoked");
      const gone = await storage.get("list", "lisbon-weekend");
      expect(gone?.revoked).toBe(true);
      // The tombstoned slug can never be claimed by someone else.
      const rival = await createShareApp({ storage }).request("https://share.test/s/lists", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"c".repeat(43)}`,
          "idempotency-key": "rival",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          desiredSlug: "lisbon-weekend",
          document: { v: 1, title: "Impostor", blocks: [], contentHash: "x" },
        }),
      });
      expect(rival.status).toBe(409);
    } finally {
      repo.db.close();
    }
  });

  it("a service failure leaves the public document untouched and the job retryable", async () => {
    const repo = await seeded();
    const { fetcher } = serviceFetcher();
    try {
      await publishList(repo, "list-1", NOW, fetcher); // published, revision 1

      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "New spot", lat: 38.73, lng: -9.16 } },
        NOW,
      );
      const failing: typeof fetch = async () => new Response("boom", { status: 503 });
      await publishList(repo, "list-1", "2026-07-19T17:00:00.000Z", failing);

      let publication = await publicationForList(repo, "list-1");
      expect(publication?.status).toBe("failed");
      // Still exactly one durable job; the published revision is untouched.
      expect(await repo.db.publicationOutbox.count()).toBe(1);
      expect(publication?.publishedRevision).toBe(1);
      expect(publication?.lastPublishedLocalRevision).not.toBe(publication?.localRevision);

      await runPublicationOutbox(repo, fetcher);
      publication = await publicationForList(repo, "list-1");
      expect(publication).toMatchObject({ status: "published", publishedRevision: 2 });
      expect(publication?.lastPublishedLocalRevision).toBe(publication?.localRevision);
    } finally {
      repo.db.close();
    }
  });

  it("walks slug collisions instead of failing the first publish", async () => {
    const { fetcher, storage } = serviceFetcher();
    // Somebody else owns the natural slug.
    await createShareApp({ storage }).request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"d".repeat(43)}`,
        "idempotency-key": "occupier",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        desiredSlug: "lisbon-weekend",
        document: { v: 1, title: "First come", blocks: [], contentHash: "x" },
      }),
    });
    const repo = await seeded();
    try {
      await publishList(repo, "list-1", NOW, fetcher);
      const publication = await publicationForList(repo, "list-1");
      expect(publication).toMatchObject({ status: "published", slug: "lisbon-weekend-2" });
    } finally {
      repo.db.close();
    }
  });
});
