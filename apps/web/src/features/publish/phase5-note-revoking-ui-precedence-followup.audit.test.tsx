/** A pending note-page DELETE must never be presented as a first-publish action. */
import { markerAt, type Note, type Publication } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { NotePublishButton } from "./NotePublishButton";

const NOW = "2026-07-19T10:00:00.000Z";

describe("Phase 5 note-page revoking UI precedence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the last public page visible without enabling Publish page while DELETE is pending", async () => {
    const repo = new DexieRepository(`phase5-note-revoking-ui-${crypto.randomUUID()}`);
    const note: Note = {
      id: "note-1",
      target: { kind: "post", postId: "post-1" },
      title: "Public note",
      body: "The last published revision remains readable until DELETE succeeds.",
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const publication: Publication = {
      id: "publication-1",
      target: { kind: "note", id: note.id },
      slug: "public-note",
      credentialId: "credential-1",
      status: "revoking",
      localRevision: "note-v1",
      lastPublishedLocalRevision: "note-v1",
      publishedRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
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
        id: "pending-revoke-job",
        publicationId: publication.id,
        action: "revoke",
        localRevision: publication.localRevision,
        createdAt: NOW,
        attempts: 0,
      });

      const realToArray = repo.db.publicationOutbox.toArray.bind(repo.db.publicationOutbox);
      let markLookupStarted!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      const observedToArray = (async () => {
        markLookupStarted();
        return realToArray();
      }) as unknown as typeof repo.db.publicationOutbox.toArray;
      vi.spyOn(repo.db.publicationOutbox, "toArray").mockImplementation(observedToArray);

      render(
        <RepoProvider repo={repo}>
          <NotePublishButton note={note} />
        </RepoProvider>,
      );
      await lookupStarted;

      expect.soft(screen.queryByTestId("note-page-link")).toBeInTheDocument();
      const primary = screen.getByTestId("publish-note");
      const enablesFirstPublish =
        primary.textContent?.trim() === "Publish page" && !primary.hasAttribute("disabled");
      expect(enablesFirstPublish, "revoking was exposed as an enabled first-publish action").toBe(
        false,
      );
      expect(screen.queryByTestId("confirm-publish-note")).not.toBeInTheDocument();
    } finally {
      repo.db.close();
    }
  });
});
