/** A failed note-page revocation must not expose an action that publishes again. */
import { markerAt, type Note, type Publication } from "@placemarks/domain";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { NotePublishButton } from "./NotePublishButton";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 note-page revocation UI precedence", () => {
  it("does not enable Update page while a failed DELETE is pending", async () => {
    const repo = new DexieRepository(`phase5-note-revoke-ui-${crypto.randomUUID()}`);
    const note: Note = {
      id: "note-1",
      target: { kind: "post", postId: "post-1" },
      title: "Public note",
      body: "This page is waiting to be removed.",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const publication: Publication = {
      id: "publication-1",
      target: { kind: "note", id: note.id },
      mode: "hosted",
      slug: "public-note",
      credentialId: "credential-1",
      status: "failed",
      localRevision: "note-v1",
      lastPublishedLocalRevision: "note-v1",
      publishedRevision: 1,
      lastError: "revoke failed (503)",
      createdAt: NOW,
      updatedAt: LATER,
    };

    try {
      await repo.createList({
        id: "list-1",
        name: "Notes",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createPost({
        id: "post-1",
        title: "Notes post",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createNote(note);
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

      render(
        <RepoProvider repo={repo}>
          <NotePublishButton note={note} />
        </RepoProvider>,
      );

      expect(await screen.findByText("revoke failed (503)")).toBeInTheDocument();
      await waitFor(() => {
        const update = screen.queryByTestId("update-note-page");
        expect(update === null || update.hasAttribute("disabled")).toBe(true);
      });
    } finally {
      repo.db.close();
    }
  });
});
