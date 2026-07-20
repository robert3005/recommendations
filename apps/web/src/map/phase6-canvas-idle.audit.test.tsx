/**
 * Canvas idling at full scale (spec/src/map-view.md §The grammar, 2026-07-19
 * late): while the pane fully occludes the canvas, viewport discovery stops
 * and projection changes defer and coalesce — applied as ONE camera move on
 * reveal. A hidden map spends no tile or discovery traffic.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneStore } from "../state/pane";
import { useProjectionStore } from "../state/projection";
import { useUiStore } from "../state/ui";
import { MapCanvas } from "./MapCanvas";

const fixture = vi.hoisted(() => ({
  discover: vi.fn(async () => ({ pois: [], truncated: false })),
  captured: undefined as
    | {
        placePins: { placeId: string; dimmed: boolean }[];
        fitTo?: { bounds: unknown; key: string } | null;
        onViewportChange?: (view: {
          bbox: { west: number; south: number; east: number; north: number };
          zoom: number;
          center: { lat: number; lng: number };
        }) => void;
      }
    | undefined,
}));

vi.mock("./MapView", () => ({
  MapView: (props: NonNullable<typeof fixture.captured>) => {
    fixture.captured = props;
    const fired = useRef(false);
    useEffect(() => {
      if (fired.current) return;
      fired.current = true;
      // The user left the map at a discovery-eligible zoom before occluding it.
      props.onViewportChange?.({
        bbox: { west: -9.2, south: 38.6, east: -9.0, north: 38.8 },
        zoom: 16,
        center: { lat: 38.7, lng: -9.1 },
      });
    }, [props.onViewportChange]);
    return <div data-testid="map-canvas" />;
  },
}));

vi.mock("../providers", () => ({
  mapStyleProvider: {
    style: () => ({ styleUrl: "/test-style.json", attribution: "© OpenStreetMap contributors" }),
  },
  searchProvider: { search: vi.fn(async () => []) },
  poiResolver: {
    resolveExact: vi.fn(async () => ({ type: "error" as const })),
    searchNearby: vi.fn(async () => []),
    discover: fixture.discover,
  },
}));

vi.mock("../data/hooks", () => ({
  useLibraryPlaces: () => [
    {
      place: {
        id: "place-1",
        origin: "manual",
        osmRefHistory: [],
        manual: { name: "Café A", lat: 38.71, lng: -9.14 },
        resolutionState: "unlinked",
        createdAt: "2026-07-19T10:00:00.000Z",
        updatedAt: "2026-07-19T10:00:00.000Z",
      },
      tags: [],
    },
    {
      place: {
        id: "place-2",
        origin: "manual",
        osmRefHistory: [],
        manual: { name: "Café B", lat: 38.75, lng: -9.1 },
        resolutionState: "unlinked",
        createdAt: "2026-07-19T10:00:00.000Z",
        updatedAt: "2026-07-19T10:00:00.000Z",
      },
      tags: [],
    },
  ],
  useLists: () => [
    {
      id: "list-1",
      name: "A",
      marker: { color: "#dc2626", icon: "circle" },
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    },
    {
      id: "list-2",
      name: "B",
      marker: { color: "#2563eb", icon: "diamond" },
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    },
  ],
  useListMembership: () => ({ "place-1": ["list-1"], "place-2": ["list-2"] }),
  usePostBlocks: () => undefined,
}));

vi.mock("../data/RepoContext", () => ({
  useRepo: () => ({ getPost: vi.fn(async () => undefined) }),
  useDexieRepo: () => ({ db: { importItems: { get: vi.fn(async () => undefined) } } }),
}));

vi.mock("../features/place/PlaceSheet", () => ({ PlaceSheet: () => null }));
vi.mock("../features/search/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../features/picker/CandidatePicker", () => ({ CandidatePicker: () => null }));
vi.mock("../features/picker/ManualPinDialog", () => ({ ManualPinDialog: () => null }));

function renderCanvas() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    view: render(
      <QueryClientProvider client={queryClient}>
        <MapCanvas />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  fixture.discover.mockClear();
  fixture.captured = undefined;
  useUiStore.setState({ selection: null, pickerAt: null, hiddenListIds: [] });
  useProjectionStore.setState({ projection: { kind: "all" } });
});

describe("Phase 6 canvas idling at full scale", () => {
  it("issues no discovery traffic while the pane fully occludes the canvas", async () => {
    usePaneStore.setState({ pane: "expanded" });
    const { queryClient, view } = renderCanvas();
    try {
      // The viewport is discovery-eligible, but the canvas is idle: nothing fires.
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fixture.discover).not.toHaveBeenCalled();
      expect(view.container.querySelector('[data-canvas-idle="1"]')).not.toBeNull();

      // Revealing the canvas resumes discovery — fetches happen only then.
      act(() => usePaneStore.setState({ pane: "split" }));
      await waitFor(() => expect(fixture.discover).toHaveBeenCalled());
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("defers and coalesces projection changes, applying one camera move on reveal", async () => {
    usePaneStore.setState({ pane: "split" });
    const { queryClient, view } = renderCanvas();
    try {
      await waitFor(() => expect(fixture.captured).toBeDefined());

      // Fully occlude, then navigate the pane through two projections.
      act(() => usePaneStore.setState({ pane: "expanded" }));
      act(() => useProjectionStore.setState({ projection: { kind: "list", listId: "list-1" } }));
      const frozen = fixture.captured;
      // The hidden canvas keeps its retained scene: no re-projection reached it.
      expect(frozen?.fitTo ?? null).toBeNull();
      act(() => useProjectionStore.setState({ projection: { kind: "list", listId: "list-2" } }));
      expect(fixture.captured?.fitTo ?? null).toBeNull();

      // Reveal: the ONE coalesced projection (the latest) applies.
      act(() => usePaneStore.setState({ pane: "split" }));
      await waitFor(() => expect(fixture.captured?.fitTo?.key).toBe("list:list-2"));
      // And the retained pins now reflect the latest projection: list-2 in
      // focus, the rest of the library dimmed.
      const pins = fixture.captured?.placePins ?? [];
      expect(pins.find((pin) => pin.placeId === "place-2")?.dimmed).toBe(false);
      expect(pins.find((pin) => pin.placeId === "place-1")?.dimmed).toBe(true);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});
