/** First-publishing a note is also creation of a hosted public link. */
import { markerAt, type Note } from "@placemarks/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { NotePublishButton } from "./NotePublishButton";

const NOW = "2026-07-19T10:00:00.000Z";

describe("Phase 5 standalone-note publication preflight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("discloses the exact note and waits for confirmation before sending it", async () => {
    const repo = new DexieRepository(`phase5-note-preflight-${crypto.randomUUID()}`);
    const note: Note = {
      id: "note-1",
      target: { kind: "post", postId: "post-1" },
      title: "Public field note",
      body: "The exact prose that would leave this device.",
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ slug: "public-field-note", revision: 1 }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetcher);

    try {
      await repo.createList({
        id: "list-1",
        name: "Field notes",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createPost({
        id: "post-1",
        title: "Lisbon field guide",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createNote(note);
      render(
        <RepoProvider repo={repo}>
          <NotePublishButton note={note} />
        </RepoProvider>,
      );

      const launch = screen.getByRole("button", { name: "Publish page" });
      await userEvent.click(launch);

      expect(await screen.findByText(note.body)).toBeInTheDocument();
      expect(screen.getByText(note.title ?? "")).toBeInTheDocument();
      expect(await screen.findByText("Lisbon field guide")).toBeInTheDocument();
      expect(fetcher).not.toHaveBeenCalled();
      const confirmation = screen.getByTestId("confirm-publish-note");
      expect(confirmation).toBeEnabled();
      await userEvent.click(confirmation);

      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const request = fetcher.mock.calls[0]?.[1];
      const submitted = JSON.parse(String(request?.body)) as {
        document: { context: unknown };
      };
      // The confirmed disclosure named the parent post. The actual public
      // document must carry that same context — the post's authoritative
      // title, never a caller-supplied label or the note title.
      expect(submitted.document.context).toEqual({ kind: "post", postTitle: "Lisbon field guide" });
    } finally {
      repo.db.close();
    }
  });
});
