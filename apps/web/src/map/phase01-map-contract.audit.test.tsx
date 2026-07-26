import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";

type MapHandler = (event?: unknown) => void;

interface MockMapInstance {
  emit(event: string, payload?: unknown): void;
  setStyle: ReturnType<typeof vi.fn>;
  flyTo: ReturnType<typeof vi.fn>;
  jumpTo: ReturnType<typeof vi.fn>;
  fitBounds: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  getSource(id: string): { setData: ReturnType<typeof vi.fn> } | undefined;
}

const maplibre = vi.hoisted(() => ({
  instances: [] as MockMapInstance[],
}));

vi.mock("maplibre-gl", () => {
  class MockControl {
    on() {
      return this;
    }
  }

  class MockMap implements MockMapInstance {
    private readonly handlers = new Map<string, MapHandler[]>();
    private readonly sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    readonly flyTo = vi.fn();
    readonly jumpTo = vi.fn();
    readonly fitBounds = vi.fn();
    readonly setStyle = vi.fn();
    readonly resize = vi.fn();

    constructor() {
      maplibre.instances.push(this);
    }

    addControl() {
      return this;
    }

    addLayer() {
      return this;
    }

    addSource(id: string) {
      this.sources.set(id, { setData: vi.fn() });
      return this;
    }

    getSource(id: string) {
      return this.sources.get(id);
    }

    getLayer() {
      return undefined;
    }

    getCenter() {
      return { lat: 51.5, lng: -0.12 };
    }

    getZoom() {
      return 12;
    }

    getBounds() {
      return { getWest: () => -1, getSouth: () => 51, getEast: () => 0, getNorth: () => 52 };
    }

    getCanvas() {
      return { style: { cursor: "" } };
    }

    on(event: string, layerOrHandler: string | MapHandler, maybeHandler?: MapHandler) {
      const handler = typeof layerOrHandler === "function" ? layerOrHandler : maybeHandler;
      if (handler) this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    once(event: string, handler: MapHandler) {
      return this.on(event, handler);
    }

    emit(event: string, payload?: unknown) {
      for (const handler of this.handlers.get(event) ?? []) handler(payload);
    }

    remove() {}

    easeTo() {}

    triggerRepaint() {}
  }

  return {
    default: {
      Map: MockMap,
      AttributionControl: MockControl,
      NavigationControl: MockControl,
      GeolocateControl: MockControl,
    },
  };
});

function mapProps(extra?: Partial<Parameters<typeof MapView>[0]>) {
  return {
    styleUrl: "/map-style.json",
    initialCenter: { lat: 51.5, lng: -0.12 },
    initialZoom: 12,
    placePins: [],
    ...extra,
  };
}

afterEach(() => {
  maplibre.instances.length = 0;
  vi.restoreAllMocks();
});

describe("map contract", () => {
  it("surfaces a basemap tile-provider failure that occurs after the style loaded", () => {
    render(<MapView {...mapProps()} />);
    const map = maplibre.instances.at(-1);
    expect(map).toBeDefined();

    act(() => {
      map?.emit("load");
      map?.emit("error", { error: new Error("Failed to load basemap tile") });
    });

    expect(screen.getByRole("status")).toHaveTextContent(/map unavailable/i);
  });

  it("uses an immediate recenter when the user prefers reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );

    render(<MapView {...mapProps({ flyTo: { lat: 48.86, lng: 2.35, zoom: 17 } })} />);
    const map = maplibre.instances.at(-1);
    expect(map).toBeDefined();

    const immediateFly = map?.flyTo.mock.calls.some(
      ([options]) => (options as { duration?: number }).duration === 0,
    );
    expect(map?.jumpTo.mock.calls.length || immediateFly).toBeTruthy();
  });

  /**
   * The covered guard (spec/src/map-view.md §The grammar): while the mobile
   * sheet fully covers the canvas nothing applies; on reveal each projection
   * effect re-runs against the CURRENT values — lazily, exactly once.
   */
  it("applies projections lazily on reveal, not while covered", async () => {
    const pin = {
      placeId: "p1",
      name: "P1",
      lat: 1,
      lng: 2,
      marker: { shape: "circle" as const, color: "#F97316" },
      listCount: 1,
      dimmed: false,
    };
    const view = render(<MapView {...mapProps({ covered: false })} />);
    const map = maplibre.instances.at(-1);
    act(() => {
      map?.emit("load");
    });
    const saved = map?.getSource("saved");
    expect(saved).toBeDefined();
    await waitFor(() => expect(saved?.setData).toHaveBeenCalled());
    saved?.setData.mockClear();

    // Covered: a pin change applies nothing.
    view.rerender(<MapView {...mapProps({ covered: true, placePins: [pin] })} />);
    expect(saved?.setData).not.toHaveBeenCalled();

    // Revealed: the current collection applies.
    view.rerender(<MapView {...mapProps({ covered: false, placePins: [pin] })} />);
    await waitFor(() => expect(saved?.setData).toHaveBeenCalled());
    const [collection] = saved?.setData.mock.calls.at(-1) ?? [];
    expect((collection as { features: unknown[] }).features).toHaveLength(1);
    // The singleton survived the covered/revealed cycle.
    expect(maplibre.instances).toHaveLength(1);
  });

  it("applies one camera move on reveal, not one per hidden change", async () => {
    const view = render(<MapView {...mapProps({ covered: true })} />);
    await waitFor(() => expect(maplibre.instances).toHaveLength(1));
    const map = maplibre.instances[0];

    view.rerender(
      <MapView
        {...mapProps({
          covered: false,
          flyTo: { lat: 48.86, lng: 2.35, zoom: 16 },
          fitTo: {
            key: "coalesced-projection",
            bounds: { west: 2.3, south: 48.8, east: 2.4, north: 48.9 },
          },
        })}
      />,
    );

    // A fly-to and a fit-to arriving together are one move, not two: the
    // explicit selection wins and the fit is not also applied.
    await waitFor(() => expect(map?.flyTo).toHaveBeenCalledOnce());
    expect(map?.fitBounds).not.toHaveBeenCalled();
  });
});
