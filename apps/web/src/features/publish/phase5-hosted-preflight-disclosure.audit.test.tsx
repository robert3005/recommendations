/** Hosted creation must stop for an exact disclosure before any bytes leave the device. */
import type { Note } from "@placemarks/domain";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { PublishControls } from "./PublishControls";

const NOW = "2026-07-19T10:00:00.000Z";

describe("Phase 5 hosted-publication preflight", () => {
  it("discloses the exact projection and waits for confirmation before creating the public page", async () => {
    const repo = new DexieRepository(`phase5-hosted-preflight-${crypto.randomUUID()}`);
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("unexpected request", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      await repo.createList({
        id: "list-1",
        name: "Private hosted guide",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await repo.addToList(
          "list-1",
          {
            kind: "manual",
            facts: { name: "Owner-added meeting point", lat: 51.501234, lng: -0.124567 },
          },
          NOW,
        )
      ).place;
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "Private itinerary detail selected for sharing.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      const view = render(
        createElement(RepoProvider, { repo }, createElement(PublishControls, { listId: "list-1" })),
      );
      const publish = await view.findByRole("button", { name: /publish hosted link/i });
      await userEvent.click(publish);

      await waitFor(() => {
        expect(view.container).toHaveTextContent("Private hosted guide");
        expect(view.container).toHaveTextContent("Owner-added meeting point");
        expect(view.container).toHaveTextContent("51.501234");
        expect(view.container).toHaveTextContent("Private itinerary detail selected for sharing.");
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      repo.db.close();
    }
  });
});
