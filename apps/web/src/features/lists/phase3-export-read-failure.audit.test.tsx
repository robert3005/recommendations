/** A portable export must fail closed when owned note content cannot be read. */
import { type List, type ListBlockView, markerAt, type Place } from "@placemarks/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListPage } from "./ListPage";

const NOW = "2026-07-19T12:00:00.000Z";
const list: List = {
  id: "list",
  name: "Portable notes",
  marker: markerAt(0),
  createdAt: NOW,
  updatedAt: NOW,
};
const place: Place = {
  id: "place",
  origin: "manual",
  pastOsmRefs: [],
  manual: { name: "Unreadable-note place", lat: 38.7, lng: -9.1 },
  resolutionState: "unlinked",
  createdAt: NOW,
  updatedAt: NOW,
};
const blocks: ListBlockView[] = [
  {
    block: {
      id: "block",
      listId: list.id,
      rank: "a0",
      content: { type: "place", placeId: place.id },
      createdAt: NOW,
      updatedAt: NOW,
    },
    place,
  },
];

const mocks = vi.hoisted(() => ({
  downloadText: vi.fn(),
  listNotesForPlace: vi.fn(async () => {
    throw new Error("IndexedDB note read failed");
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ listId: list.id }),
}));
vi.mock("../../data/hooks", () => ({
  useList: () => list,
  useListBlocks: () => blocks,
  usePostsForList: () => [],
  useLists: () => [list],
}));
vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({
    getPlaceView: vi.fn(async () => ({ place, tags: [] })),
    listNotesForPlace: mocks.listNotesForPlace,
    moveBlock: vi.fn(),
    removeBlock: vi.fn(),
    updateList: vi.fn(),
  }),
}));
vi.mock("../../lib/download", () => ({
  downloadText: mocks.downloadText,
  downloadBytes: vi.fn(),
}));
vi.mock("../publish/PublishControls", () => ({ PublishControls: () => null }));

describe("Phase 3 export read failures", () => {
  beforeEach(() => {
    mocks.downloadText.mockClear();
    mocks.listNotesForPlace.mockClear();
  });

  it("does not download a silently note-less file when reading a note fails", async () => {
    render(<ListPage />);
    fireEvent.click(screen.getByTestId("export-geojson"));

    await waitFor(() => expect(mocks.listNotesForPlace).toHaveBeenCalledOnce());
    expect(mocks.downloadText).not.toHaveBeenCalled();
  });
});
