/**
 * book/src/map-view.md requires a bounded retry/error state for nearby
 * candidate failures. The recovery action must retry in-place rather than
 * requiring the user to dismiss and reconstruct the long-press workflow.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CandidatePicker } from "./CandidatePicker";

const provider = vi.hoisted(() => ({ searchNearby: vi.fn() }));

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: vi.fn(),
    discover: vi.fn(),
    searchNearby: provider.searchNearby,
  },
}));

describe("Phase 1 nearby-candidate recovery", () => {
  it("offers an in-place retry after the resolver fails", async () => {
    provider.searchNearby
      .mockRejectedValueOnce(new Error("resolver offline"))
      .mockResolvedValueOnce([]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <CandidatePicker lat={51.5} lng={-0.12} onSelect={vi.fn()} onClose={vi.fn()} />
        </QueryClientProvider>,
      );

      expect(
        await screen.findByText(/could not reach OpenStreetMap services/i),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /retry/i }));

      expect(await screen.findByTestId("no-candidates")).toBeInTheDocument();
      expect(provider.searchNearby).toHaveBeenCalledTimes(2);
    } finally {
      queryClient.clear();
    }
  });
});
