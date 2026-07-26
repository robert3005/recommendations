/** Exhausting a permanent DELETE failure must preserve its operation and idempotency key. */
import { markerAt, type Publication } from "@placemarks/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { PublishControls } from "./PublishControls";
import { runPublicationOutbox } from "./publication";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 exhausted revocation precedence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries the original DELETE rather than turning a repeatedly failed revoke into PUT", async () => {
    const repo = new DexieRepository(`phase5-exhausted-revoke-${crypto.randomUUID()}`);
    const publication: Publication = {
      id: "publication-1",
      target: { kind: "list", id: "list-1" },
      slug: "public-guide",
      credentialId: "credential-1",
      status: "failed",
      lastPublishedHash: "guide-v1",
      publishedRevision: 1,
      lastError: "revoke failed (403)",
      createdAt: NOW,
      updatedAt: LATER,
    };
    const originalJob = {
      publicationId: publication.id,
      revoke: {
        key: "original-revoke-job",
        createdAt: NOW,
        attempts: 5,
        lastError: publication.lastError,
      },
    };

    try {
      await repo.createList({
        id: "list-1",
        name: "Public guide",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.db.credentials.put({
        id: "credential-1",
        token: "a".repeat(43),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.db.publications.put(publication);
      await repo.db.publicationJobs.put(originalJob);

      await runPublicationOutbox(
        repo,
        vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 })),
      );

      // An exhausted REVOKE is never abandoned — unlike a publish draft, it
      // keeps its original key so Retry can only ever mean DELETE.
      expect.soft((await repo.db.publicationJobs.get(publication.id))?.revoke).toMatchObject({
        key: "original-revoke-job",
        attempts: 6,
      });

      const retryRequests: Array<{ method: string; idempotencyKey: string | null }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (_input, init) => {
          const method = init?.method ?? "GET";
          retryRequests.push({
            method,
            idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
          });
          return method === "DELETE"
            ? new Response(null, { status: 204 })
            : Response.json({ slug: publication.slug, revision: 2 }, { status: 200 });
        }),
      );

      render(
        <RepoProvider repo={repo}>
          <PublishControls listId="list-1" />
        </RepoProvider>,
      );
      const retry = await screen.findByRole("button", { name: /^retry$/i });
      await waitFor(() => expect(retry).toBeEnabled());
      await userEvent.click(retry);
      await waitFor(() => expect(retryRequests).toHaveLength(1));

      expect(retryRequests).toEqual([{ method: "DELETE", idempotencyKey: originalJob.revoke.key }]);
    } finally {
      repo.db.close();
    }
  });
});
