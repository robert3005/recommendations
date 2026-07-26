import { type List, type ListBlockView, markerAt, type Note, type Place } from "@placemarks/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListPage } from "./ListPage";

const NOW = "2026-07-19T12:00:00.000Z";
const MY_MAPS_FILE_LIMIT = 5 * 1024 * 1024;
const list: List = {
  id: "large-notes-list",
  name: "Large notes trip",
  marker: markerAt(0),
  createdAt: NOW,
  updatedAt: NOW,
};

const blocks: ListBlockView[] = Array.from({ length: 100 }, (_, index) => {
  const place: Place = {
    id: `place-${index.toString()}`,
    origin: "manual",
    osmRefHistory: [],
    manual: { name: `Place ${index.toString()}`, lat: 38.7, lng: -9.1 },
    resolutionState: "unlinked",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    block: {
      id: `block-${index.toString()}`,
      listId: list.id,
      rank: index.toString().padStart(5, "0"),
      content: { type: "place", placeId: place.id },
      createdAt: NOW,
      updatedAt: NOW,
    },
    place,
  };
});

const { downloadText } = vi.hoisted(() => ({ downloadText: vi.fn() }));

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
    getPlaceView: vi.fn(async () => ({ tags: [] })),
    listNotesForPlace: vi.fn(
      async (placeId: string): Promise<Note[]> => [
        {
          id: `note-${placeId}`,
          target: { kind: "place", placeId },
          body: "x".repeat(60_000),
          shareable: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    ),
    moveBlock: vi.fn(),
    removeBlock: vi.fn(),
    updateList: vi.fn(),
  }),
}));

vi.mock("../../lib/download", () => ({
  downloadText,
  downloadBytes: vi.fn(),
}));

vi.mock("../publish/PublishControls", () => ({ PublishControls: () => null }));

describe("Phase 3 Google My Maps file-size limit", () => {
  beforeEach(() => downloadText.mockClear());

  it("splits KML output when notes make a sub-2,000-place list exceed 5 MB", async () => {
    render(<ListPage />);
    fireEvent.click(screen.getByRole("button", { name: /send to google my maps/i }));

    await waitFor(() => expect(downloadText).toHaveBeenCalled());
    const outputs = downloadText.mock.calls.map((call) => call[2] as string);

    expect(outputs.length).toBeGreaterThan(1);
    expect(
      outputs.every((output) => new TextEncoder().encode(output).byteLength <= MY_MAPS_FILE_LIMIT),
    ).toBe(true);
  });
});
