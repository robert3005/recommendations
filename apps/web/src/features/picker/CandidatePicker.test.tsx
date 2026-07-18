/**
 * Missing-POI escape paths (book/src/place-identity.md): when nothing is mapped
 * at a location the picker offers "Add it on OpenStreetMap" (preferred for real
 * public POIs) and, when wired, "Save as unlinked pin" for spots that don't
 * belong in OSM.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CandidatePicker } from "./CandidatePicker";

function renderPicker(onSaveManual?: (pos: { lat: number; lng: number }) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CandidatePicker
        lat={0}
        lng={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        {...(onSaveManual ? { onSaveManual } : {})}
      />
    </QueryClientProvider>,
  );
}

describe("missing-POI escape paths", () => {
  it("always offers the upstream path: Add it on OpenStreetMap", () => {
    renderPicker();
    expect(screen.getByRole("link", { name: "Add it on OpenStreetMap" })).toHaveAttribute(
      "href",
      expect.stringContaining("openstreetmap.org/edit"),
    );
    // Without a manual-save handler wired, no unlinked-pin button is offered.
    expect(screen.queryByRole("button", { name: "Save as unlinked pin" })).not.toBeInTheDocument();
  });

  it("offers the unlinked-pin path when wired, alongside the upstream path", () => {
    const onSaveManual = vi.fn();
    renderPicker(onSaveManual);
    expect(screen.getByRole("button", { name: "Save as unlinked pin" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add it on OpenStreetMap" })).toBeInTheDocument();
  });
});
