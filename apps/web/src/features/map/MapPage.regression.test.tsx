import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapPage } from "./MapPage";

const fixture = vi.hoisted(() => ({
  capturedProps: undefined as
    | { placePins: Array<{ placeId: string; color: string; unlinked: boolean }> }
    | undefined,
}));

vi.mock("../../data/hooks", () => ({
  useLibraryPlaces: () => [
    {
      place: {
        id: "imported-place",
        origin: "import",
        osmRefHistory: [],
        manual: { name: "Imported café", lat: 38.7139, lng: -9.1394 },
        resolutionState: "unlinked",
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      tags: [],
    },
  ],
  useLists: () => [
    {
      id: "takeout-list",
      name: "Takeout",
      marker: { color: "#2563eb", icon: "circle" },
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:00:00.000Z",
    },
  ],
  useListMembership: () => ({ "imported-place": ["takeout-list"] }),
}));

vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({}),
  useDexieRepo: () => ({ db: { importItems: { get: vi.fn() } } }),
}));

vi.mock("../../map/MapView", () => ({
  MapView: (props: typeof fixture.capturedProps) => {
    fixture.capturedProps = props;
    return null;
  },
}));

vi.mock("../../providers", () => ({
  poiResolver: { discover: vi.fn(), searchNearby: vi.fn() },
  searchProvider: { search: vi.fn() },
}));

vi.mock("../place/PlaceSheet", () => ({ PlaceSheet: () => null }));
vi.mock("../search/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../picker/CandidatePicker", () => ({ CandidatePicker: () => null }));
vi.mock("../picker/ManualPinDialog", () => ({ ManualPinDialog: () => null }));

describe("Phase 3 imported map markers", () => {
  it("keeps an unlinked imported place in its list colour, flagged unlinked", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MapPage />
      </QueryClientProvider>,
    );

    // 2026-07-19 (spec/src/map-view.md): list identity owns the pin's look —
    // an unlinked place wears its list marker colour; the `unlinked` flag only
    // drives the small "not linked" dot, never a special colour.
    expect(fixture.capturedProps?.placePins).toEqual([
      expect.objectContaining({ placeId: "imported-place", color: "#2563eb", unlinked: true }),
    ]);
  });
});
