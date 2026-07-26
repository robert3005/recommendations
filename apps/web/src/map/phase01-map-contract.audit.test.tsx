import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";

type MapHandler = (event?: unknown) => void;

interface MockMapInstance {
  emit(event: string, payload?: unknown): void;
  injectLateManager(): void;
  initialStyle: unknown;
  setStyle: ReturnType<typeof vi.fn>;
  flyTo: ReturnType<typeof vi.fn>;
  jumpTo: ReturnType<typeof vi.fn>;
  fitBounds: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  rawTriggerRepaint: ReturnType<typeof vi.fn>;
  frameAbort: ReturnType<typeof vi.fn>;
  tilePause: ReturnType<typeof vi.fn>;
  tileResume: ReturnType<typeof vi.fn>;
  tileReload: ReturnType<typeof vi.fn>;
  abortTile: ReturnType<typeof vi.fn>;
  tile: { state: string; aborted: boolean };
}

const maplibre = vi.hoisted(() => ({
  instances: [] as MockMapInstance[],
  startWithManager: true,
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
    readonly stop = vi.fn();
    readonly resize = vi.fn();
    readonly rawTriggerRepaint = vi.fn();
    triggerRepaint = this.rawTriggerRepaint;
    readonly frameAbort = vi.fn();
    readonly tilePause = vi.fn();
    readonly tileResume = vi.fn();
    readonly tileReload = vi.fn();
    readonly abortTile = vi.fn(async () => {});
    readonly tile = { state: "loading", aborted: false };
    _frameRequest: { abort: ReturnType<typeof vi.fn> } | null = { abort: this.frameAbort };
    readonly _renderTaskQueue = { clear: vi.fn() };
    readonly style = {
      tileManagers: {} as Record<
        string,
        {
          pause: () => void;
          resume: () => void;
          reload: (changed?: boolean) => void;
          getSource: () => {
            abortTile: (tile: { state: string; aborted: boolean }) => Promise<void>;
          };
          _inViewTiles: { getAllTiles: () => { state: string; aborted: boolean }[] };
        }
      >,
    };

    readonly initialStyle: unknown;

    constructor(options?: { style?: unknown }) {
      this.initialStyle = options?.style;
      if (maplibre.startWithManager) this.injectLateManager();
      maplibre.instances.push(this);
    }

    injectLateManager() {
      this.tile.aborted = false;
      this._frameRequest = { abort: this.frameAbort };
      this.style.tileManagers.late = {
        pause: this.tilePause,
        resume: this.tileResume,
        reload: this.tileReload,
        getSource: () => ({ abortTile: this.abortTile }),
        _inViewTiles: { getAllTiles: () => [this.tile] },
      };
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

function idleMap(idle: boolean, styleUrl = "/map-style.json") {
  return (
    <MapView
      idle={idle}
      styleUrl={styleUrl}
      initialCenter={{ lat: 51.5, lng: -0.12 }}
      initialZoom={12}
      placePins={[]}
      poiPins={[]}
    />
  );
}

afterEach(() => {
  maplibre.instances.length = 0;
  maplibre.startWithManager = true;
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

  it("keeps the singleton mounted while hidden and pauses frames and tile work", async () => {
    const view = render(idleMap(true));
    await waitFor(() => expect(maplibre.instances).toHaveLength(1));
    const map = maplibre.instances[0];
    expect(map).toBeDefined();
    expect(map?.initialStyle).toBeUndefined();
    await waitFor(() => {
      expect(map?.stop).toHaveBeenCalledOnce();
      expect(map?.tilePause).toHaveBeenCalledOnce();
      expect(map?.abortTile).toHaveBeenCalledOnce();
    });

    // Hidden configuration changes coalesce without recreating the map or
    // starting the superseded provider style.
    view.rerender(idleMap(true, "/newest-map-style.json"));
    expect(map?.setStyle).not.toHaveBeenCalled();
    view.rerender(idleMap(false, "/newest-map-style.json"));
    await waitFor(() => {
      expect(map?.setStyle).toHaveBeenCalledOnce();
      expect(map?.setStyle).toHaveBeenCalledWith("/newest-map-style.json");
      expect(map?.tileResume).toHaveBeenCalledOnce();
      expect(map?.tileReload).toHaveBeenCalledWith(true);
    });
    expect(maplibre.instances).toHaveLength(1);

    view.rerender(
      <MapView
        idle={false}
        styleUrl="/newest-map-style.json"
        initialCenter={{ lat: 51.5, lng: -0.12 }}
        initialZoom={12}
        placePins={[]}
        poiPins={[]}
        flyTo={{ lat: 48.86, lng: 2.35, zoom: 16 }}
        fitTo={{
          key: "coalesced-projection",
          bounds: { west: 2.3, south: 48.8, east: 2.4, north: 48.9 },
        }}
      />,
    );
    await waitFor(() => expect(map?.flyTo).toHaveBeenCalledOnce());
    expect(map?.fitBounds).not.toHaveBeenCalled();
  });

  it("quiesces a tile manager created by late style data while hidden and resumes the same map", async () => {
    maplibre.startWithManager = false;
    const view = render(idleMap(false));
    const map = maplibre.instances[0];
    expect(map).toBeDefined();
    map?.resize.mockClear();
    map?.rawTriggerRepaint.mockClear();
    map?.frameAbort.mockClear();

    view.rerender(idleMap(true));
    await waitFor(() => expect(map?.stop).toHaveBeenCalled());
    expect(map?.tilePause).not.toHaveBeenCalled();

    act(() => {
      map?.injectLateManager();
      map?.emit("dataloading");
      map?.emit("data", { sourceId: "basemap", sourceDataType: "content" });
      (map as (MockMapInstance & { triggerRepaint: () => void }) | undefined)?.triggerRepaint();
    });
    await waitFor(() => {
      expect(map?.tilePause).toHaveBeenCalledOnce();
      expect(map?.abortTile).toHaveBeenCalledOnce();
      expect(map?.frameAbort).toHaveBeenCalled();
    });
    expect(map?.rawTriggerRepaint).not.toHaveBeenCalled();
    expect(map?.tile.aborted).toBe(true);

    view.rerender(idleMap(false));
    await waitFor(() => {
      expect(map?.tileResume).toHaveBeenCalledOnce();
      expect(map?.tileReload).toHaveBeenCalledWith(true);
      expect(map?.resize).toHaveBeenCalled();
      expect(map?.rawTriggerRepaint).toHaveBeenCalledOnce();
    });
    expect(map?.tile.aborted).toBe(false);
    expect(maplibre.instances).toHaveLength(1);
  });
});
