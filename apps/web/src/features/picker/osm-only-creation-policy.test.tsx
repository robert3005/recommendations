/**
 * Missing-POI escape paths, per the ratified design (book/src/place-identity.md,
 * 2026-07-18 review): when nothing is mapped at a location the picker offers BOTH
 * "Add it on OpenStreetMap" (preferred for real public POIs — improves the shared
 * map) AND "Save as unlinked pin" (user-ratified manual pins for spots that don't
 * belong in OSM). An earlier revision asserted the manual option must not exist;
 * that reflected the proposal the design review explicitly overruled.
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

  it("offers the unlinked-pin path when wired (ratified: manual pins are in scope)", () => {
    const onSaveManual = vi.fn();
    renderPicker(onSaveManual);
    expect(screen.getByRole("button", { name: "Save as unlinked pin" })).toBeInTheDocument();
    // Both escape paths coexist; the upstream path is never removed.
    expect(screen.getByRole("link", { name: "Add it on OpenStreetMap" })).toBeInTheDocument();
  });
});
