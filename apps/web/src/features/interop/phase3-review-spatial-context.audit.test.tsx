/**
 * Ambiguous import review gets spatial context on the MAIN canvas
 * (spec/src/interop.md §Import queue model, 2026-07-19 late — the bespoke
 * mini map is retired): the review queue is a pane route whose item under
 * review projects lettered candidate marks onto the persistent map, while
 * the pane keeps a keyboard-accessible candidate picker.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectionStore } from "../../state/projection";
import { ReviewPage } from "./ReviewPage";

const fixture = vi.hoisted(() => ({
  startPlacing: vi.fn(),
  stopPlacing: vi.fn(),
  setReviewError: vi.fn(),
  clearReviewError: vi.fn(),
  setPane: vi.fn(),
  resolveReviewItem: vi.fn(
    async (): Promise<{ status: "resolved" } | { status: "pending"; reason: string }> => ({
      status: "resolved",
    }),
  ),
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
    selector: (state: {
      startPlacingImportItem: typeof fixture.startPlacing;
      stopPlacingImportItem: typeof fixture.stopPlacing;
      placingImportItemId: null;
      importReviewError: null;
      setImportReviewError: typeof fixture.setReviewError;
      clearImportReviewError: typeof fixture.clearReviewError;
    }) => unknown,
  ) =>
    selector({
      startPlacingImportItem: fixture.startPlacing,
      stopPlacingImportItem: fixture.stopPlacing,
      placingImportItemId: null,
      importReviewError: null,
      setImportReviewError: fixture.setReviewError,
      clearImportReviewError: fixture.clearReviewError,
    }),
}));
vi.mock("../../state/pane", () => ({
  usePaneStore: (selector: (state: { setPane: typeof fixture.setPane }) => unknown) =>
    selector({ setPane: fixture.setPane }),
}));
vi.mock("./importer", () => ({ resolveReviewItem: fixture.resolveReviewItem }));

describe("Phase 3 review-queue spatial context", () => {
  beforeEach(() => {
    useProjectionStore.setState({ projection: { kind: "all" } });
    fixture.startPlacing.mockClear();
    fixture.stopPlacing.mockClear();
    fixture.setReviewError.mockClear();
    fixture.clearReviewError.mockClear();
    fixture.setPane.mockClear();
    fixture.resolveReviewItem.mockReset();
    fixture.resolveReviewItem.mockResolvedValue({ status: "resolved" });
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

  it("offers keyboard coordinate placement and disarms map placement on route exit", async () => {
    const view = render(<ReviewPage />);

    fireEvent.change(screen.getByLabelText("Latitude for Central"), {
      target: { value: "38.7139" },
    });
    fireEvent.change(screen.getByLabelText("Longitude for Central"), {
      target: { value: "-9.1394" },
    });
    fireEvent.click(screen.getByTestId("review-place-at-coordinates"));

    await waitFor(() =>
      expect(fixture.resolveReviewItem).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "review-1",
        { kind: "coords", lat: 38.7139, lng: -9.1394 },
        expect.any(String),
      ),
    );

    fireEvent.click(screen.getByTestId("review-place-on-map"));
    expect(fixture.startPlacing).toHaveBeenCalledWith("review-1");
    expect(fixture.setPane).toHaveBeenCalledWith("split");
    view.unmount();
    expect(fixture.stopPlacing).toHaveBeenCalled();
  });

  it("surfaces a failed candidate verification and leaves an explicit retry control", async () => {
    fixture.resolveReviewItem.mockResolvedValueOnce({
      status: "pending",
      reason: "The OSM candidate could not be verified. Check the connection and retry.",
    });
    render(<ReviewPage />);

    fireEvent.change(screen.getByTestId("review-candidates"), {
      target: { value: "node/101" },
    });
    const retry = screen.getByTestId("review-try-candidate");
    fireEvent.click(retry);

    await waitFor(() =>
      expect(fixture.setReviewError).toHaveBeenCalledWith(
        "review-1",
        expect.stringMatching(/could not be verified/i),
      ),
    );
    expect(retry).toBeEnabled();
  });
});
