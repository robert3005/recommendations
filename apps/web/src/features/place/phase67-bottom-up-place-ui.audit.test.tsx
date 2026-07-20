/**
 * Revised-spec regression: bottom-up teardown is a user-facing refusal, not
 * an unhandled rejected promise. The place card must preserve the selection
 * and name the authored content that has to be dismantled first.
 */
import { type Place, TeardownRefusedError } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

const NOW = "2026-07-20T00:00:00.000Z";
const place: Place = {
  id: "guarded-place",
  origin: "manual",
  osmRefHistory: [],
  manual: { name: "Guarded café", category: "cafe", lat: 51.5, lng: -0.12 },
  resolutionState: "unlinked",
  createdAt: NOW,
  updatedAt: NOW,
};

const mocks = vi.hoisted(() => ({
  clearSelection: vi.fn(),
  removePlace: vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useListIdsForPlace: () => ["list-1"],
  useLists: () => [],
  useNotesForPlace: () => [],
  usePlaceView: () => ({ place, tags: [] }),
  useTags: () => [],
}));

vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({
    addToList: vi.fn(),
    assignTag: vi.fn(),
    createList: vi.fn(),
    createNote: vi.fn(),
    deleteNote: vi.fn(),
    removePlace: mocks.removePlace,
    removeTagAssignment: vi.fn(),
    updateNote: vi.fn(),
    updatePlace: vi.fn(),
  }),
}));

vi.mock("../../state/ui", () => ({
  useUiStore: (selector: (state: { clearSelection: () => void }) => unknown) =>
    selector({ clearSelection: mocks.clearSelection }),
}));

describe("Phase 6/7 place-card teardown refusal", () => {
  beforeEach(() => {
    mocks.clearSelection.mockClear();
    mocks.removePlace.mockReset();
    mocks.removePlace.mockRejectedValue(
      new TeardownRefusedError("authored content blocks removal", {
        notes: [
          {
            placeId: place.id,
            noteId: "note-1",
            title: "Why this place matters",
          },
        ],
        embeds: [
          {
            placeId: place.id,
            postId: "post-1",
            postTitle: "A weekend in London",
            blockId: "embed-1",
          },
        ],
        posts: [],
        members: [],
      }),
    );
  });

  it("surfaces named blockers and keeps the place selected", async () => {
    render(<PlaceDetailsSheet placeId={place.id} />);

    await userEvent.click(screen.getByTestId("remove-place"));

    const refusal = await screen.findByRole("alertdialog");
    expect(refusal).toHaveTextContent("Why this place matters");
    expect(refusal).toHaveTextContent("A weekend in London");
    expect(mocks.clearSelection).not.toHaveBeenCalled();
  });
});
