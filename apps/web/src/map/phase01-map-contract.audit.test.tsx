import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";

type MapHandler = (event?: unknown) => void;

interface MockMapInstance {
  emit(event: string, payload?: unknown): void;
  flyTo: ReturnType<typeof vi.fn>;
  jumpTo: ReturnType<typeof vi.fn>;
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

function renderMap(flyTo?: { lat: number; lng: number; zoom?: number }) {
  return render(
    <MapView
      styleUrl="/map-style.json"
      initialCenter={{ lat: 51.5, lng: -0.12 }}
      initialZoom={12}
      placePins={[]}
      poiPins={[]}
      flyTo={flyTo}
    />,
  );
}

afterEach(() => {
  maplibre.instances.length = 0;
  vi.restoreAllMocks();
});

describe("Phase 0/1 map contract", () => {
  it("surfaces a basemap tile-provider failure that occurs after the style loaded", () => {
    renderMap();
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

    renderMap({ lat: 48.86, lng: 2.35, zoom: 17 });
    const map = maplibre.instances.at(-1);
    expect(map).toBeDefined();

    const immediateFly = map?.flyTo.mock.calls.some(
      ([options]) => (options as { duration?: number }).duration === 0,
    );
    expect(map?.jumpTo.mock.calls.length || immediateFly).toBeTruthy();
  });
});
