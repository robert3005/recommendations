/** User-facing acceptance check for spec/src/interop.md's My Maps export contract. */
import { type List, type ListBlockView, markerAt, type Place } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ListPage } from "./ListPage";

const NOW = "2026-07-19T12:00:00.000Z";
const list: List = {
  id: "large-list",
  name: "Large trip",
  marker: markerAt(0),
  createdAt: NOW,
  updatedAt: NOW,
};

const place: Place = {
  id: "place",
  origin: "import",
  osmRefHistory: [],
  manual: { name: "Example", lat: 38.7, lng: -9.1 },
  resolutionState: "unlinked",
  createdAt: NOW,
  updatedAt: NOW,
};

const blocks: ListBlockView[] = Array.from({ length: 2_001 }, (_, index) => {
  const member = { ...place, id: `place-${index}` };
  return {
    block: {
      id: `block-${index}`,
      listId: list.id,
      rank: String(index).padStart(5, "0"),
      content: { type: "place" as const, placeId: member.id },
      createdAt: NOW,
      updatedAt: NOW,
    },
    place: member,
  };
});

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
    listNotesForPlace: vi.fn(async () => []),
    moveBlock: vi.fn(),
    removeBlock: vi.fn(),
    updateList: vi.fn(),
  }),
}));

// Hosted publishing is Phase 4 and orthogonal to this Phase 3 export surface.
vi.mock("../publish/PublishControls", () => ({ PublishControls: () => null }));

describe("Phase 3 Google My Maps export acceptance", () => {
  // A 2,000-place acceptance render is legitimately heavy under a fully
  // parallel suite — give it an explicit budget instead of the default.
  it("offers KML and KMZ, explains the limits/split, and gives the import handoff", {
    timeout: 20_000,
  }, () => {
    render(<ListPage />);

    expect.soft(screen.queryByTestId("export-kml")).toBeInTheDocument();
    expect.soft(screen.queryByTestId("export-kmz")).toBeInTheDocument();
    expect
      .soft(screen.queryByRole("button", { name: /send to google my maps/i }))
      .toBeInTheDocument();
    expect.soft(screen.queryByText(/2,000/)).toBeInTheDocument();
    expect.soft(screen.queryByText(/5\s*MB/i)).toBeInTheDocument();
    expect.soft(screen.queryByText(/split/i)).toBeInTheDocument();
    expect
      .soft(screen.queryByText(/My Maps\s*→\s*Import\s*→\s*choose this file/i))
      .toBeInTheDocument();
  });
});
