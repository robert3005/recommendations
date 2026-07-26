import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapCanvas } from "../../map/MapCanvas";
import { usePaneStore } from "../../state/pane";

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
        pastOsmRefs: [],
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
      marker: { color: "#2b8fd6", icon: "circle" },
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:00:00.000Z",
    },
  ],
  useListMembership: () => ({ "imported-place": ["takeout-list"] }),
  usePostBlocks: () => undefined,
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
  mapStyleProvider: {
    style: () => ({ styleUrl: "/test-style.json", attribution: "© OpenStreetMap contributors" }),
  },
  poiResolver: { discover: vi.fn(), searchNearby: vi.fn() },
  searchProvider: { search: vi.fn() },
}));

vi.mock("../place/PlaceSheet", () => ({ PlaceSheet: () => null }));
vi.mock("../search/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../picker/CandidatePicker", () => ({ CandidatePicker: () => null }));
vi.mock("../picker/ManualPinDialog", () => ({ ManualPinDialog: () => null }));

beforeEach(() => {
  usePaneStore.setState({ pane: "collapsed" });
});

describe("Phase 3 imported map markers", () => {
  it("keeps an unlinked imported place in its list colour, flagged unlinked", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MapCanvas />
      </QueryClientProvider>,
    );

    // 2026-07-19 (spec/src/map-view.md): list identity owns the pin's look —
    // an unlinked place wears its list marker colour; the `unlinked` flag only
    // drives the small "not linked" dot, never a special colour.
    expect(fixture.capturedProps?.placePins).toEqual([
      expect.objectContaining({ placeId: "imported-place", color: "#2b8fd6", unlinked: true }),
    ]);
  });
});
