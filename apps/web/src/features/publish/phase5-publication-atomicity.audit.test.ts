/**
 * Focused regressions for Phase 5 local publication atomicity and queue ordering.
 *
 * The book requires a guide edit, every affected Publication revision, and its
 * durable outbox job to commit as one aggregate transaction. Queue ordering is
 * per publication: a failure for one public page must not starve another page.
 */
import type { Note, Publication } from "@placemarks/domain";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { revokePublication, runPublicationOutbox } from "./publication";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";
const LATEST = "2026-07-19T12:00:00.000Z";

function hostedPublication(
  id: string,
  target: Publication["target"],
  slug: string,
  credentialId: string,
): Publication {
  return {
    id,
    target,
    mode: "hosted",
    slug,
    credentialId,
    status: "published",
    localRevision: `${id}-revision-1`,
    lastPublishedLocalRevision: `${id}-revision-1`,
    publishedRevision: 1,
    lastPublishedHash: `${id}-revision-1`,
    publishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function seedList(repo: DexieRepository, id: string, name: string): Promise<void> {
  await repo.createList({ id, name, createdAt: NOW, updatedAt: NOW });
}

describe("Phase 5 aggregate publication transactions", () => {
  it("rolls publication state and its outbox back when the matching list edit cannot commit", async () => {
    const repo = new DexieRepository(`phase5-atomic-list-${crypto.randomUUID()}`);
    try {
      await seedList(repo, "list-1", "Original title");
      const publication = hostedPublication(
        "publication-1",
        { kind: "list", id: "list-1" },
        "original-title",
        "credential-1",
      );
      await repo.db.publications.put(publication);

      const put = vi
        .spyOn(repo.db.lists, "put")
        .mockRejectedValueOnce(new Error("simulated IndexedDB write failure"));
      await expect(
        repo.updateList({
          id: "list-1",
          name: "Uncommitted title",
          createdAt: NOW,
          updatedAt: LATER,
        }),
      ).rejects.toThrow(/write failure/i);
      put.mockRestore();

      await expect(repo.getList("list-1")).resolves.toMatchObject({ name: "Original title" });
      await expect(repo.db.publications.get(publication.id)).resolves.toEqual(publication);
      await expect(repo.db.publicationOutbox.count()).resolves.toBe(0);
    } finally {
      vi.restoreAllMocks();
      repo.db.close();
    }
  });
});

describe("Phase 5 per-publication outbox draining", () => {
  it("continues with another publication when the oldest page has a retryable failure", async () => {
    const repo = new DexieRepository(`phase5-independent-drain-${crypto.randomUUID()}`);
    const blocked = {
      ...hostedPublication(
        "publication-blocked",
        { kind: "list", id: "list-blocked" },
        "blocked-guide",
        "credential-blocked",
      ),
      status: "queued" as const,
      publishedRevision: undefined,
      lastPublishedLocalRevision: undefined,
    };
    const healthy = {
      ...hostedPublication(
        "publication-healthy",
        { kind: "list", id: "list-healthy" },
        "healthy-guide",
        "credential-healthy",
      ),
      status: "queued" as const,
      publishedRevision: undefined,
      lastPublishedLocalRevision: undefined,
    };
    try {
      await repo.db.credentials.bulkPut([
        {
          id: "credential-blocked",
          token: "a".repeat(43),
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "credential-healthy",
          token: "b".repeat(43),
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);
      await repo.db.publications.bulkPut([blocked, healthy]);
      await repo.db.publicationOutbox.bulkPut([
        {
          id: "job-blocked",
          publicationId: blocked.id,
          action: "publish",
          localRevision: blocked.localRevision,
          payload: JSON.stringify({
            v: 1,
            title: "Blocked guide",
            blocks: [],
            contentHash: blocked.localRevision,
          }),
          createdAt: NOW,
          attempts: 0,
        },
        {
          id: "job-healthy",
          publicationId: healthy.id,
          action: "publish",
          localRevision: healthy.localRevision,
          payload: JSON.stringify({
            v: 1,
            title: "Healthy guide",
            blocks: [],
            contentHash: healthy.localRevision,
          }),
          createdAt: LATER,
          attempts: 0,
        },
      ]);

      const attemptedSlugs: string[] = [];
      const fetcher: typeof fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { desiredSlug: string };
        attemptedSlugs.push(request.desiredSlug);
        if (request.desiredSlug === blocked.slug) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        return Response.json({ slug: request.desiredSlug, revision: 1 }, { status: 201 });
      };

      await runPublicationOutbox(repo, fetcher);

      expect(attemptedSlugs).toEqual(["blocked-guide", "healthy-guide"]);
      await expect(repo.db.publications.get(blocked.id)).resolves.toMatchObject({
        status: "failed",
      });
      await expect(repo.db.publications.get(healthy.id)).resolves.toMatchObject({
        status: "published",
        lastPublishedLocalRevision: healthy.localRevision,
      });
      expect((await repo.db.publicationOutbox.toArray()).map((job) => job.id)).toEqual([
        "job-blocked",
      ]);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 5 publication fan-out for shareable notes", () => {
  it("queues every containing guide and the standalone note page after a body/title edit", async () => {
    const repo = new DexieRepository(`phase5-note-edit-fanout-${crypto.randomUUID()}`);
    try {
      await seedList(repo, "list-1", "First guide");
      await seedList(repo, "list-2", "Second guide");
      const place = (
        await repo.addToList(
          "list-1",
          {
            kind: "manual",
            facts: { name: "Shared place", lat: 51.5, lng: -0.12 },
          },
          NOW,
        )
      ).place;
      await repo.addToList("list-2", { kind: "existing", placeId: place.id }, NOW);

      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Old title",
        body: "Old body",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      const publications = [
        hostedPublication(
          "publication-list-1",
          { kind: "list", id: "list-1" },
          "first-guide",
          "credential-list-1",
        ),
        hostedPublication(
          "publication-list-2",
          { kind: "list", id: "list-2" },
          "second-guide",
          "credential-list-2",
        ),
        hostedPublication(
          "publication-note",
          { kind: "note", id: note.id },
          "old-title",
          "credential-note",
        ),
      ];
      await repo.db.publications.bulkPut(publications);

      await repo.updateNote({
        ...note,
        title: "Edited title",
        body: "Edited body",
        updatedAt: LATER,
      });

      await expect(repo.db.notes.get(note.id)).resolves.toMatchObject({
        title: "Edited title",
        body: "Edited body",
      });
      for (const publication of publications) {
        await expect(repo.db.publications.get(publication.id)).resolves.toMatchObject({
          status: "queued",
          localRevision: expect.not.stringMatching(`${publication.id}-revision-1`),
        });
      }
      const jobs = await repo.db.publicationOutbox.toArray();
      expect(jobs).toHaveLength(3);
      expect(jobs).toEqual(
        expect.arrayContaining(
          publications.map((publication) =>
            expect.objectContaining({ publicationId: publication.id, action: "publish" }),
          ),
        ),
      );
      expect(jobs).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ action: "revoke" })]),
      );
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 5 publish/revoke sequencing", () => {
  it("does not let a failed unsent update strand a newer explicit revocation", async () => {
    const repo = new DexieRepository(`phase5-revoke-supersedes-update-${crypto.randomUUID()}`);
    try {
      await seedList(repo, "list-1", "Published guide");
      const publication = hostedPublication(
        "publication-1",
        { kind: "list", id: "list-1" },
        "published-guide",
        "credential-1",
      );
      await repo.db.credentials.put({
        id: "credential-1",
        token: "c".repeat(43),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.db.publications.put(publication);

      await repo.updateList({
        id: "list-1",
        name: "Private draft that must not block unpublish",
        createdAt: NOW,
        updatedAt: LATER,
      });

      const methods: string[] = [];
      const fetcher: typeof fetch = async (_input, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "PUT") return new Response("temporarily unavailable", { status: 503 });
        if (method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`unexpected ${method} request`);
      };

      await revokePublication(repo, publication.id, LATEST, fetcher);

      expect(methods).toContain("DELETE");
      await expect(repo.db.publications.get(publication.id)).resolves.toMatchObject({
        status: "revoked",
      });
      expect(
        (await repo.db.publicationOutbox.toArray()).filter(
          (job) => job.publicationId === publication.id && job.action === "revoke",
        ),
      ).toHaveLength(0);
    } finally {
      repo.db.close();
    }
  });
});
