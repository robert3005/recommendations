/** Unpublish UI must be honest about copies outside the service's control. */
import { markerAt, type Publication } from "@placemarks/domain";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { PublishControls } from "./PublishControls";

const NOW = "2026-07-19T10:00:00.000Z";

describe("Phase 5 unpublish honesty", () => {
  it("explains that downloaded copies and third-party caches cannot be remotely erased", async () => {
    const repo = new DexieRepository(`phase5-unpublish-honesty-${crypto.randomUUID()}`);
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("unexpected request", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      await repo.createList({
        id: "list-1",
        name: "Public guide",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const publication: Publication = {
        id: "publication-1",
        target: { kind: "list", id: "list-1" },
        slug: "public-guide",
        credentialId: "credential-1",
        status: "published",
        localRevision: "revision-1",
        lastPublishedLocalRevision: "revision-1",
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.db.publications.put(publication);
      await repo.db.credentials.put({
        id: "credential-1",
        token: "a".repeat(43),
        createdAt: NOW,
        updatedAt: NOW,
      });

      const view = render(
        createElement(RepoProvider, { repo }, createElement(PublishControls, { listId: "list-1" })),
      );

      // The warning may be persistent owner guidance or part of an unpublish
      // confirmation. The design requires the disclosure, not one particular
      // dialog or request-timing implementation.
      if (!view.queryByText(/downloaded copies/i)) {
        await userEvent.click(await view.findByRole("button", { name: /unpublish/i }));
      }

      await waitFor(() => {
        expect(view.container).toHaveTextContent(/downloaded copies/i);
        expect(view.container).toHaveTextContent(/third.party caches/i);
        expect(view.container).toHaveTextContent(/cannot.*(?:erase|remove)/i);
      });
    } finally {
      vi.unstubAllGlobals();
      repo.db.close();
    }
  });
});
