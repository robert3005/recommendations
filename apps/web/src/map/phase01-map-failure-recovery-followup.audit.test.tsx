/** A MapLibre `idle` event means requests stopped; it does not prove that an
 * errored basemap tile subsequently rendered successfully. */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";

type Handler = (event?: unknown) => void;
interface MockMap {
  emit(event: string, payload?: unknown): void;
}

const maplibre = vi.hoisted(() => ({ instances: [] as MockMap[] }));

vi.mock("maplibre-gl", () => {
  class Control {
    on() {
      return this;
    }
  }

  class MockMapLibre implements MockMap {
    private readonly handlers = new globalThis.Map<string, Handler[]>();
    private readonly sources = new globalThis.Map<string, { setData: ReturnType<typeof vi.fn> }>();

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
    remove() {}
    easeTo() {}
    flyTo() {}
    resize() {}
    triggerRepaint() {}
  }

  return {
    default: {
      Map: MockMapLibre,
      AttributionControl: Control,
      NavigationControl: Control,
      GeolocateControl: Control,
    },
  };
});

afterEach(() => {
  maplibre.instances.length = 0;
});

describe("Phase 0 basemap recovery evidence", () => {
  it("does not clear Map unavailable merely because the failed request cycle became idle", () => {
    render(
      <MapView
        styleUrl="/map-style.json"
        initialCenter={{ lat: 51.5, lng: -0.12 }}
        initialZoom={12}
        placePins={[]}
      />,
    );
    const map = maplibre.instances[0];
    expect(map).toBeDefined();

    act(() => {
      map?.emit("load");
      map?.emit("error", { error: new Error("tile request failed") });
      map?.emit("idle");
    });

    expect(screen.getByRole("status")).toHaveTextContent(/map unavailable/i);
  });

  it("does not treat local saved-place source data as basemap recovery", () => {
    render(
      <MapView
        styleUrl="/map-style.json"
        initialCenter={{ lat: 51.5, lng: -0.12 }}
        initialZoom={12}
        placePins={[]}
      />,
    );
    const map = maplibre.instances[0];
    expect(map).toBeDefined();

    act(() => {
      map?.emit("load");
      map?.emit("error", { error: new Error("basemap tile request failed") });
      map?.emit("data", {
        dataType: "source",
        sourceId: "saved",
        sourceDataType: "content",
        isSourceLoaded: true,
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent(/map unavailable/i);
  });

  it("does not treat a basemap source-idle data event as recovery", () => {
    render(
      <MapView
        styleUrl="/map-style.json"
        initialCenter={{ lat: 51.5, lng: -0.12 }}
        initialZoom={12}
        placePins={[]}
      />,
    );
    const map = maplibre.instances[0];
    expect(map).toBeDefined();

    act(() => {
      map?.emit("load");
      map?.emit("error", { error: new Error("basemap tile request failed") });
      map?.emit("data", {
        dataType: "source",
        sourceId: "basemap-vector",
        sourceDataType: "idle",
        isSourceLoaded: true,
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent(/map unavailable/i);
  });
});
