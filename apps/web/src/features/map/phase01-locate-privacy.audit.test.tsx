/**
 * Privacy contract from spec/src/map-view.md: Locate is user-triggered and may
 * recenter the camera, but the resulting precise position is never persisted
 * as the next-launch viewport.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPage } from "./MapPage";

type Handler = (event?: unknown) => void;

const maplibre = vi.hoisted(() => ({
  maps: [] as Array<{
    center: { lat: number; lng: number };
    zoom: number;
    emit: (event: string, payload?: unknown) => void;
  }>,
  geolocates: [] as Array<{ locateFromUser: (lat: number, lng: number) => void }>,
}));

const viewport = vi.hoisted(() => ({ persist: vi.fn() }));

vi.mock("../../lib/viewport", () => ({
  initialViewport: () => ({ lat: 51.5, lng: -0.12, zoom: 12 }),
  persistViewport: viewport.persist,
}));

vi.mock("../../data/hooks", () => ({
  useLibraryPlaces: () => [],
  useLists: () => [],
  useListMembership: () => ({}),
}));

vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({}),
  useDexieRepo: () => ({ db: { importItems: { get: vi.fn() } } }),
}));

vi.mock("../../providers", () => ({
  searchProvider: { search: vi.fn(async () => []) },
  poiResolver: {
    resolveExact: vi.fn(async () => ({ type: "error" as const })),
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

vi.mock("../place/PlaceSheet", () => ({ PlaceSheet: () => null }));
vi.mock("../search/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../picker/CandidatePicker", () => ({ CandidatePicker: () => null }));
vi.mock("../picker/ManualPinDialog", () => ({ ManualPinDialog: () => null }));

vi.mock("maplibre-gl", () => {
  class MockControl {
    on() {
      return this;
    }
  }

  class MockMap {
    readonly handlers = new Map<string, Handler[]>();
    readonly sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    center = { lat: 51.5, lng: -0.12 };
    zoom = 12;

    constructor() {
      maplibre.maps.push(this);
    }

    addControl(control: { attach?: (map: MockMap) => void }) {
      control.attach?.(this);
      return this;
    }

    addSource(id: string) {
      this.sources.set(id, { setData: vi.fn() });
      return this;
    }

    addLayer() {
      return this;
    }

    getSource(id: string) {
      return this.sources.get(id);
    }

    getCenter() {
      return this.center;
    }

    getZoom() {
      return this.zoom;
    }

    getBounds() {
      return {
        getWest: () => this.center.lng - 0.01,
        getSouth: () => this.center.lat - 0.01,
        getEast: () => this.center.lng + 0.01,
        getNorth: () => this.center.lat + 0.01,
      };
    }

    getCanvas() {
      return { style: { cursor: "" } };
    }

    on(event: string, layerOrHandler: string | Handler, maybeHandler?: Handler) {
      const handler = typeof layerOrHandler === "function" ? layerOrHandler : maybeHandler;
      if (handler) this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    emit(event: string, payload?: unknown) {
      for (const handler of this.handlers.get(event) ?? []) handler(payload);
    }

    flyTo() {}
    easeTo() {}
    remove() {}
  }

  class MockGeolocateControl {
    private map?: MockMap;

    constructor() {
      maplibre.geolocates.push(this);
    }

    attach(map: MockMap) {
      this.map = map;
    }

    on() {
      return this;
    }

    /** Simulates the camera move performed after the user presses Locate. */
    locateFromUser(lat: number, lng: number) {
      if (!this.map) throw new Error("geolocate control is not attached");
      this.map.center = { lat, lng };
      this.map.zoom = 15;
      this.map.emit("move");
      this.map.emit("moveend");
    }
  }

  return {
    default: {
      Map: MockMap,
      AttributionControl: MockControl,
      NavigationControl: MockControl,
      GeolocateControl: MockGeolocateControl,
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  viewport.persist.mockReset();
  maplibre.maps.length = 0;
  maplibre.geolocates.length = 0;
});

describe("Phase 0 Locate privacy", () => {
  it("does not persist the precise camera center produced by Locate", () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MapPage />
      </QueryClientProvider>,
    );

    try {
      const geolocate = maplibre.geolocates.at(-1);
      expect(geolocate).toBeDefined();
      act(() => {
        geolocate?.locateFromUser(51.501_234, -0.123_456);
        vi.advanceTimersByTime(401);
      });

      const persisted = viewport.persist.mock.calls.map(
        ([value]) => value as { lat: number; lng: number; zoom: number },
      );
      // Keeping the previous viewport or a deliberately coarse regional
      // centre is compatible with next-launch restoration. Persisting a
      // centre within roughly street-level identifying resolution of the
      // Locate result is not.
      expect(
        persisted.some(
          ({ lat, lng }) =>
            Math.abs(lat - 51.501_234) < 0.001 && Math.abs(lng - -0.123_456) < 0.001,
        ),
      ).toBe(false);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});
