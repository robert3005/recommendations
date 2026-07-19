/** Ambiguous import review requires a mini map beside the candidate picker. */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportSection } from "./ImportSection";

const fixture = vi.hoisted(() => ({
  startPlacing: vi.fn(),
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

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
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

describe("Phase 3 review-queue spatial context", () => {
  it("shows ambiguous candidates on a labelled mini map beside the picker", () => {
    render(<ImportSection />);

    const review = screen.getByTestId("review-item");
    expect(within(review).getByTestId("review-candidates")).toBeInTheDocument();
    const semanticMap =
      within(review).queryByRole("img", { name: /map/i }) ??
      within(review).queryByRole("region", { name: /map/i });
    const visualMap =
      semanticMap ??
      review.querySelector(
        '[data-testid="review-mini-map"], .maplibregl-map, [aria-label*="map" i]',
      );

    expect(visualMap).not.toBeNull();
  });
});
