/** A failed revocation retries DELETE; it must never queue a publication update. */
import type { Publication } from "@placemarks/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { PublishControls } from "./PublishControls";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 failed-revocation retry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses the pending DELETE job instead of publishing to the revoked slug", async () => {
    const repo = new DexieRepository(`phase5-revoke-retry-ui-${crypto.randomUUID()}`);
    const publication: Publication = {
      id: "publication-1",
      target: { kind: "list", id: "list-1" },
      mode: "hosted",
      slug: "public-guide",
      credentialId: "credential-1",
      status: "failed",
      localRevision: "local-v1",
      lastPublishedLocalRevision: "local-v1",
      publishedRevision: 1,
      lastError: "revoke failed (503)",
      createdAt: NOW,
      updatedAt: LATER,
    };
    const requests: Array<{ method: string; idempotencyKey: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        const headers = new Headers(init?.headers);
        const method = init?.method ?? "GET";
        requests.push({ method, idempotencyKey: headers.get("idempotency-key") });
        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response("revoked", { status: 404 });
      }),
    );

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
      await repo.db.publicationOutbox.put({
        id: "original-revoke-job",
        publicationId: publication.id,
        action: "revoke",
        localRevision: publication.localRevision,
        createdAt: NOW,
        attempts: 1,
        lastError: publication.lastError,
      });

      const view = render(
        createElement(RepoProvider, { repo }, createElement(PublishControls, { listId: "list-1" })),
      );
      await userEvent.click(await screen.findByRole("button", { name: /^retry$/i }));

      await waitFor(async () => {
        await expect(repo.db.publications.get(publication.id)).resolves.toMatchObject({
          status: "revoked",
        });
      });
      // A retry may perform a harmless public read, but it must not turn the
      // failed revoke into a POST/PUT. The only mutation is the original
      // idempotent DELETE job.
      expect(requests.filter(({ method }) => method !== "GET")).toEqual([
        { method: "DELETE", idempotencyKey: "original-revoke-job" },
      ]);
      view.unmount();
    } finally {
      repo.db.close();
    }
  });
});
