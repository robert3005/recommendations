import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { NoteEditor } from "./NoteEditor";

describe("NoteEditor", () => {
  it("removes an existing optional title when the author clears it", async () => {
    const repo = new DexieRepository(`note-editor-${crypto.randomUUID()}`);
    const onSave = vi.fn();
    try {
      render(
        <RepoProvider repo={repo}>
          <NoteEditor
            note={{
              id: "note-1",
              target: { kind: "place", placeId: "place-1" },
              title: "Old title",
              body: "Body",
              shareable: false,
              createdAt: "2026-07-18T00:00:00.000Z",
              updatedAt: "2026-07-18T00:00:00.000Z",
            }}
            onSave={onSave}
            onCancel={vi.fn()}
          />
        </RepoProvider>,
      );

      const user = userEvent.setup();
      await user.clear(screen.getByRole("textbox", { name: "Note title" }));
      await user.click(screen.getByRole("button", { name: "Save note" }));

      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("title");
    } finally {
      repo.db.close();
    }
  });
});
