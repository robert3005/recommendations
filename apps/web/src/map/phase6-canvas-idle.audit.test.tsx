/**
 * Canvas idling at full scale (spec/src/map-view.md §The grammar, 2026-07-19
 * late): while the pane fully occludes the canvas, viewport discovery stops
 * and projection changes defer and coalesce — applied as ONE camera move on
 * reveal. A hidden map spends no tile or discovery traffic.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneStore } from "../state/pane";
import { useProjectionStore } from "../state/projection";
import { useUiStore } from "../state/ui";
import { MapCanvas } from "./MapCanvas";

const fixture = vi.hoisted(() => ({
  discover: vi.fn(async (_bbox?: unknown, options?: { signal?: AbortSignal }) => {
    fixture.lastDiscoverSignal = options?.signal;
    return { pois: [], truncated: false };
  }),
  lastDiscoverSignal: undefined as AbortSignal | undefined,
  reportViewport: true,
  resolveReviewItem: vi.fn(
    async (): Promise<
      { status: "resolved" } | { status: "pending"; reason: string } | { status: "ignored" }
    > => ({ status: "resolved" }),
  ),
  membership: { "place-1": ["list-1"], "place-2": ["list-2"] } as Record<string, string[]>,
  post: undefined as { id: string; listId: string } | undefined,
  postBlocks: undefined as
    | {
        block: { content: { type: "place" } };
        place: { id: string };
      }[]
    | undefined,
  reviewItem: undefined as
    | {
        id: string;
        raw: { title: string };
        coords?: { lat: number; lng: number };
        candidates?: {
          ref: { type: "node"; id: string };
          name: string;
          lat: number;
          lng: number;
        }[];
      }
    | undefined,
  captured: undefined as
    | {
        idle?: boolean;
        initialCenter?: { lat: number; lng: number };
        initialZoom?: number;
        routeCamera?: { lat: number; lng: number; zoom: number; key: string } | null;
        placePins: {
          placeId: string;
          dimmed: boolean;
          color: string;
          icon: string;
          multi: boolean;
        }[];
        markPins?: { key: string; name: string; label: string; unlinked?: boolean }[];
        selectionPin?: { lat: number; lng: number } | null;
        onSelectPlace?: (placeId: string) => void;
        onSelectMark?: (mark: { key: string; name: string; label: string }) => void;
        onLongPress?: (position: { lat: number; lng: number }) => void;
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
      if (fired.current || !fixture.reportViewport) return;
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
        pastOsmRefs: [],
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
        pastOsmRefs: [],
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
  useListMembership: () => fixture.membership,
  usePostBlocks: () => fixture.postBlocks,
}));

vi.mock("../data/RepoContext", () => ({
  useRepo: () => ({ getPost: vi.fn(async () => fixture.post) }),
  useDexieRepo: () => ({
    db: { importItems: { get: vi.fn(async () => fixture.reviewItem) } },
  }),
}));

vi.mock("../features/place/PlaceSheet", () => ({ PlaceSheet: () => null }));
vi.mock("../features/interop/importer", () => ({
  resolveReviewItem: fixture.resolveReviewItem,
}));
vi.mock("../features/search/SearchBar", () => ({
  SearchBar: () => <div data-testid="search-bar" />,
}));
vi.mock("../features/picker/CandidatePicker", () => ({ CandidatePicker: () => null }));
vi.mock("../features/picker/ManualPinDialog", () => ({ ManualPinDialog: () => null }));

function renderCanvas(readOnly = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    view: render(
      <QueryClientProvider client={queryClient}>
        <MapCanvas readOnly={readOnly} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  fixture.discover.mockClear();
  fixture.discover.mockImplementation(
    async (_bbox?: unknown, options?: { signal?: AbortSignal }) => {
      fixture.lastDiscoverSignal = options?.signal;
      return { pois: [], truncated: false };
    },
  );
  fixture.lastDiscoverSignal = undefined;
  fixture.reportViewport = true;
  fixture.resolveReviewItem.mockReset();
  fixture.resolveReviewItem.mockResolvedValue({ status: "resolved" });
  fixture.membership = { "place-1": ["list-1"], "place-2": ["list-2"] };
  fixture.post = undefined;
  fixture.postBlocks = undefined;
  fixture.reviewItem = undefined;
  fixture.captured = undefined;
  useUiStore.setState({ selection: null, pickerAt: null, hiddenListIds: [] });
  useProjectionStore.setState({ projection: { kind: "all" } });
});

describe("Phase 6 canvas idling at full scale", () => {
  it("starts from the persisted viewport and survives navigation without remounting", () => {
    usePaneStore.setState({ pane: "split" });
    fixture.reportViewport = false;
    // The start camera comes from the persisted last viewport (or a
    // timezone-derived approximation). There is no URL camera to arbitrate
    // against — it duplicated this and forced a hand-ranked three-way ladder.
    const { queryClient, view } = renderCanvas();
    try {
      const started = fixture.captured;
      expect(started?.initialCenter).toBeDefined();
      expect(typeof started?.initialZoom).toBe("number");

      view.rerender(
        <QueryClientProvider client={queryClient}>
          <MapCanvas />
        </QueryClientProvider>,
      );
      // The singleton keeps its camera across navigation: same construction
      // arguments, no remount.
      expect(fixture.captured?.initialCenter).toEqual(started?.initialCenter);
      expect(fixture.captured?.initialZoom).toBe(started?.initialZoom);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("issues no discovery traffic while the pane fully occludes the canvas", async () => {
    usePaneStore.setState({ pane: "expanded" });
    const { queryClient, view } = renderCanvas();
    try {
      // The viewport is discovery-eligible, but the canvas is idle: nothing fires.
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fixture.discover).not.toHaveBeenCalled();
      expect(view.container.querySelector('[data-canvas-idle="1"]')).not.toBeNull();
      expect(fixture.captured?.idle).toBe(true);

      // Revealed and explicitly asked, the fetch happens — and only then.
      act(() => usePaneStore.setState({ pane: "split" }));
      const ask = await screen.findByTestId("show-nearby-places");
      act(() => ask.click());
      await waitFor(() => expect(fixture.discover).toHaveBeenCalled());
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("applies one camera move on reveal, for the latest projection only", async () => {
    usePaneStore.setState({ pane: "split" });
    const { queryClient, view } = renderCanvas();
    try {
      await waitFor(() => expect(fixture.captured).toBeDefined());

      // Fully occlude, then navigate the pane through two projections.
      act(() => usePaneStore.setState({ pane: "expanded" }));
      act(() => useProjectionStore.setState({ projection: { kind: "list", listId: "list-1" } }));
      // Hidden means idle: the canvas applies nothing, which is enforced by the
      // `if (idle) return` guard on every projection effect rather than by
      // withholding the props. Intermediate projections therefore need no
      // buffering — only the last one can ever be applied.
      expect(fixture.captured?.idle).toBe(true);
      act(() => useProjectionStore.setState({ projection: { kind: "list", listId: "list-2" } }));
      expect(fixture.captured?.idle).toBe(true);

      // Reveal: the latest projection — and only it — applies.
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

  it("aborts discovery which was already in flight when the pane fully occludes", async () => {
    usePaneStore.setState({ pane: "split" });
    fixture.discover.mockImplementationOnce(
      async (_bbox?: unknown, options?: { signal?: AbortSignal }) => {
        fixture.lastDiscoverSignal = options?.signal;
        return new Promise<{ pois: never[]; truncated: false }>(() => {});
      },
    );
    const { queryClient, view } = renderCanvas();
    try {
      const ask = await screen.findByTestId("show-nearby-places");
      act(() => ask.click());
      await waitFor(() => expect(fixture.lastDiscoverSignal).toBeDefined());
      expect(fixture.lastDiscoverSignal?.aborted).toBe(false);
      act(() => usePaneStore.setState({ pane: "expanded" }));
      await waitFor(() => expect(fixture.lastDiscoverSignal?.aborted).toBe(true));
      expect(fixture.captured?.idle).toBe(true);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("isolates shared/review projections and draws the imported review coordinate", async () => {
    usePaneStore.setState({ pane: "split" });
    const { queryClient, view } = renderCanvas();
    try {
      act(() =>
        useProjectionStore.setState({
          projection: {
            kind: "shared",
            pins: [{ key: "public-1", name: "Public place", lat: 1, lng: 2, unlinked: true }],
          },
        }),
      );
      await waitFor(() => expect(fixture.captured?.markPins?.[0]?.name).toBe("Public place"));
      expect(fixture.captured?.markPins?.[0]?.unlinked).toBe(true);
      expect(fixture.captured?.placePins).toEqual([]);
      expect(view.queryByTestId("list-toggles")).not.toBeInTheDocument();

      fixture.reviewItem = {
        id: "review-1",
        raw: { title: "Imported coordinate" },
        coords: { lat: 38.7, lng: -9.1 },
        candidates: [
          {
            ref: { type: "node", id: "123" },
            name: "Candidate",
            lat: 38.71,
            lng: -9.11,
          },
        ],
      };
      act(() =>
        useProjectionStore.setState({ projection: { kind: "review", itemId: "review-1" } }),
      );
      await waitFor(() => expect(fixture.captured?.markPins).toHaveLength(2));
      expect(fixture.captured?.placePins).toEqual([]);
      expect(fixture.captured?.markPins?.[0]).toMatchObject({
        name: "Imported coordinate",
        label: "•",
      });
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("surfaces pending map-side review attempts and offers explicit placement cancellation", async () => {
    usePaneStore.setState({ pane: "collapsed" });
    fixture.reviewItem = {
      id: "review-1",
      raw: { title: "Imported coordinate" },
      coords: { lat: 38.7, lng: -9.1 },
      candidates: [
        {
          ref: { type: "node", id: "123" },
          name: "Candidate",
          lat: 38.71,
          lng: -9.11,
        },
      ],
    };
    useProjectionStore.setState({ projection: { kind: "review", itemId: "review-1" } });
    fixture.resolveReviewItem.mockResolvedValue({
      status: "pending",
      reason: "The candidate could not be verified.",
    });
    const { queryClient, view } = renderCanvas();
    try {
      await waitFor(() => expect(fixture.captured?.markPins).toHaveLength(2));
      const candidate = fixture.captured?.markPins?.[1];
      if (!candidate) throw new Error("candidate mark missing");
      act(() => fixture.captured?.onSelectMark?.(candidate));
      await waitFor(() =>
        expect(useUiStore.getState().importReviewError).toEqual({
          itemId: "review-1",
          message: "The candidate could not be verified.",
        }),
      );
      expect(usePaneStore.getState().pane).toBe("split");

      act(() => useUiStore.getState().startPlacingImportItem("review-1"));
      expect(screen.getByTestId("placing-import-hint")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(useUiStore.getState().placingImportItemId).toBeNull();

      act(() => useUiStore.getState().startPlacingImportItem("review-1"));
      act(() => fixture.captured?.onLongPress?.({ lat: 38.72, lng: -9.12 }));
      await waitFor(() => expect(fixture.resolveReviewItem).toHaveBeenCalledTimes(2));
      expect(useUiStore.getState().importReviewError?.message).toMatch(/could not be verified/i);
      expect(usePaneStore.getState().pane).toBe("split");
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("does not expose a stale private scene while a public route is still loading", async () => {
    usePaneStore.setState({ pane: "split" });
    useProjectionStore.setState({ projection: { kind: "all" } });
    useUiStore.setState({
      selection: {
        kind: "osm",
        ref: { type: "node", id: "999" },
        hint: { name: "Private selection", lat: 51.5, lng: -0.12 },
      },
    });
    const { queryClient, view } = renderCanvas(true);
    try {
      await waitFor(() => expect(fixture.captured).toBeDefined());
      expect(fixture.captured?.placePins).toEqual([]);
      expect(fixture.captured?.selectionPin).toBeNull();
      expect(view.queryByTestId("list-toggles")).not.toBeInTheDocument();
      expect(view.queryByTestId("search-bar")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("uses the post's own list marker instead of another membership's marker", async () => {
    usePaneStore.setState({ pane: "split" });
    fixture.membership = {
      "place-1": ["list-1", "list-2"],
      "place-2": ["list-2"],
    };
    fixture.post = { id: "post-1", listId: "list-2" };
    fixture.postBlocks = [{ block: { content: { type: "place" } }, place: { id: "place-1" } }];
    useProjectionStore.setState({ projection: { kind: "post", postId: "post-1" } });
    const { queryClient, view } = renderCanvas();
    try {
      await waitFor(() =>
        expect(fixture.captured?.placePins.find((pin) => pin.placeId === "place-1")).toMatchObject({
          color: "#2563eb",
          icon: "diamond",
          multi: false,
        }),
      );
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});
