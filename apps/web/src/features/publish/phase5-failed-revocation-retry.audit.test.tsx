/** A failed revocation retries DELETE; it must never queue a publication update. */
import { markerAt, type Publication } from "@placemarks/domain";
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
      slug: "public-guide",
      credentialId: "credential-1",
      status: "failed",
      lastPublishedHash: "local-v1",
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
      await repo.db.publicationJobs.put({
        publicationId: publication.id,
        revoke: {
          key: "original-revoke-job",
          createdAt: NOW,
          attempts: 1,
          lastError: publication.lastError,
        },
      });

      // Hold the component's first outbox lookup open. Publication state is
      // already available, so the Retry control can render while its action is
      // still unknown. The spec requires that this window never defaults to a
      // publish: Retry must be disabled until the pending DELETE is known, or
      // otherwise resolve the operation before acting.
      const realGet = repo.db.publicationJobs.get.bind(repo.db.publicationJobs);
      let releaseLookup!: () => void;
      let markLookupStarted!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const delayedGet = (async (key: string) => {
        markLookupStarted();
        await lookupGate;
        return realGet(key);
      }) as unknown as typeof repo.db.publicationJobs.get;
      vi.spyOn(repo.db.publicationJobs, "get")
        .mockImplementationOnce(delayedGet)
        .mockImplementation(realGet);

      const view = render(
        createElement(RepoProvider, { repo }, createElement(PublishControls, { listId: "list-1" })),
      );
      await lookupStarted;
      // The authoritative UI contract is explicit: Retry remains visible but
      // disabled until the outbox has resolved whether it means DELETE or PUT.
      const earlyRetry = screen.getByRole("button", { name: /^retry$/i });
      expect(earlyRetry).toBeDisabled();
      releaseLookup();

      // It becomes actionable only after its DELETE meaning is known.
      await waitFor(() => expect(earlyRetry).toBeEnabled());
      await userEvent.click(earlyRetry);

      await waitFor(async () => {
        await expect(repo.db.publications.get(publication.id)).resolves.toMatchObject({
          status: "revoked",
        });
      });
      // Wait for the chosen action to drain completely. Without this, the
      // erroneous path can momentarily mark the DELETE successful and only
      // issue its forbidden PUT on the next microtask.
      await waitFor(async () => {
        await expect(repo.db.publicationJobs.count()).resolves.toBe(0);
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
