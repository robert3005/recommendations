/** A single large feature cannot be split between KML files; the My Maps
 * handoff must refuse it rather than emit a file above the documented limit. */
import { type List, type ListBlockView, markerAt, type Note, type Place } from "@placemarks/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListPage } from "./ListPage";

const NOW = "2026-07-19T12:00:00.000Z";
const MY_MAPS_FILE_LIMIT = 5 * 1024 * 1024;
const list: List = {
  id: "one-oversized-feature",
  name: "One enormous note",
  marker: markerAt(0),
  createdAt: NOW,
  updatedAt: NOW,
};
const place: Place = {
  id: "place-1",
  origin: "manual",
  osmRefHistory: [],
  manual: { name: "One place", lat: 38.7, lng: -9.1 },
  resolutionState: "unlinked",
  createdAt: NOW,
  updatedAt: NOW,
};
const blocks: ListBlockView[] = [
  {
    block: {
      id: "block-1",
      listId: list.id,
      rank: "a",
      content: { type: "place", placeId: place.id },
      createdAt: NOW,
      updatedAt: NOW,
    },
    place,
  },
];

const mocks = vi.hoisted(() => ({
  downloadText: vi.fn(),
  listNotesForPlace: vi.fn<() => Promise<Note[]>>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ listId: list.id }),
}));

vi.mock("../../data/hooks", () => ({
  useList: () => list,
  useListBlocks: () => blocks,
  useLists: () => [list],
}));

vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({
    getPlaceView: vi.fn(async () => ({ tags: [] })),
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

describe("Phase 3 Google My Maps unsplittable feature", () => {
  beforeEach(() => {
    mocks.downloadText.mockClear();
    mocks.listNotesForPlace.mockReset().mockResolvedValue([
      {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "x".repeat(MY_MAPS_FILE_LIMIT + 4096),
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  it("never downloads a KML part larger than 5 MB", async () => {
    render(<ListPage />);
    fireEvent.click(screen.getByRole("button", { name: /send to google my maps/i }));

    // Completion is either a compliant refusal surfaced in the UI or one or
    // more downloads. It must never be an oversized download.
    await waitFor(() => {
      const refused = screen.queryByText(/export failed|too large|exceeds/i);
      expect(refused !== null || mocks.downloadText.mock.calls.length > 0).toBe(true);
    });
    const outputs = mocks.downloadText.mock.calls.map((call) => call[2] as string);
    expect(
      outputs.every((output) => new TextEncoder().encode(output).byteLength <= MY_MAPS_FILE_LIMIT),
    ).toBe(true);
  });
});
