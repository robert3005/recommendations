import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CandidatePicker } from "./CandidatePicker";

describe("OSM-only place creation policy", () => {
  it("sends a missing POI upstream without offering a coordinate-only save", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <CandidatePicker
          lat={0}
          lng={0}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onSaveManual={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("link", { name: "Add it on OpenStreetMap" })).toHaveAttribute(
      "href",
      expect.stringContaining("openstreetmap.org/edit"),
    );
    expect(screen.queryByRole("button", { name: "Save as unlinked pin" })).not.toBeInTheDocument();
  });
});
