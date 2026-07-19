/** Exhausting a permanent DELETE failure must preserve its operation and idempotency key. */
import type { Publication } from "@placemarks/domain";
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
      mode: "hosted",
      slug: "public-guide",
      credentialId: "credential-1",
      status: "failed",
      localRevision: "guide-v1",
      lastPublishedLocalRevision: "guide-v1",
      publishedRevision: 1,
      lastError: "revoke failed (403)",
      createdAt: NOW,
      updatedAt: LATER,
    };
    const originalJob = {
      id: "original-revoke-job",
      publicationId: publication.id,
      action: "revoke" as const,
      localRevision: publication.localRevision,
      createdAt: NOW,
      attempts: 5,
      lastError: publication.lastError,
    };

    try {
      await repo.createList({
        id: "list-1",
        name: "Public guide",
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
      await repo.db.publicationOutbox.put(originalJob);

      await runPublicationOutbox(
        repo,
        vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 })),
      );

      expect.soft(await repo.db.publicationOutbox.get(originalJob.id)).toMatchObject({
        id: originalJob.id,
        action: "revoke",
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

      expect(retryRequests).toEqual([{ method: "DELETE", idempotencyKey: originalJob.id }]);
    } finally {
      repo.db.close();
    }
  });
});
