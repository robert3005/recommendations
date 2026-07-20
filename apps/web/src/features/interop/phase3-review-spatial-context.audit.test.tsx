/**
 * Ambiguous import review gets spatial context on the MAIN canvas
 * (spec/src/interop.md §Import queue model, 2026-07-19 late — the bespoke
 * mini map is retired): the review queue is a pane route whose item under
 * review projects lettered candidate marks onto the persistent map, while
 * the pane keeps a keyboard-accessible candidate picker.
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectionStore } from "../../state/projection";
import { ReviewPage } from "./ReviewPage";

const fixture = vi.hoisted(() => ({
  startPlacing: vi.fn(),
  setPane: vi.fn(),
  reviewItems: [
    {
      id: "review-1",
      batchId: "batch-1",
      targetListId: "list-1",
      raw: { title: "Central", address: "10 Example Road, Lisbon" },
      candidates: [
        {
          ref: { type: "node" as const, id: "101" },
          name: "Central Café",
          category: "cafe",
          address: "10 Example Road, Lisbon",
          lat: 38.7139,
          lng: -9.1394,
        },
        {
          ref: { type: "node" as const, id: "102" },
          name: "Central Café",
          category: "cafe",
          address: "20 Other Road, Lisbon",
          lat: 38.722,
          lng: -9.151,
        },
      ],
      status: "review" as const,
    },
  ],
}));

vi.mock("../../data/hooks", () => ({ useReviewItems: () => fixture.reviewItems }));
vi.mock("../../data/RepoContext", () => ({ useDexieRepo: () => ({}) }));
vi.mock("../../providers", () => ({
  searchProvider: { search: vi.fn(async () => []) },
  poiResolver: {
    resolveExact: vi.fn(async () => ({ type: "gone" as const })),
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));
vi.mock("../../state/ui", () => ({
  useUiStore: (
    selector: (state: { startPlacingImportItem: typeof fixture.startPlacing }) => unknown,
  ) => selector({ startPlacingImportItem: fixture.startPlacing }),
}));
vi.mock("../../state/pane", () => ({
  usePaneStore: (selector: (state: { setPane: typeof fixture.setPane }) => unknown) =>
    selector({ setPane: fixture.setPane }),
}));

describe("Phase 3 review-queue spatial context", () => {
  beforeEach(() => {
    useProjectionStore.setState({ projection: { kind: "all" } });
  });

  it("projects the item under review onto the main canvas with lettered candidates", async () => {
    render(<ReviewPage />);

    // The pane keeps the accessible picker, its options lettered to match the
    // canvas marks (the pane is the map's non-map equivalent).
    const review = screen.getByTestId("review-item");
    const picker = within(review).getByTestId("review-candidates");
    const options = within(picker).getAllByRole("option");
    expect(options.map((option) => option.textContent?.trim()[0])).toEqual(["L", "A", "B"]);

    // The route published the review projection: the SINGLETON canvas shows
    // the candidates — no bespoke mini map exists any more.
    expect(useProjectionStore.getState().projection).toEqual({
      kind: "review",
      itemId: "review-1",
    });
    expect(review.querySelector('[data-testid="review-mini-map"]')).toBeNull();
  });
});
