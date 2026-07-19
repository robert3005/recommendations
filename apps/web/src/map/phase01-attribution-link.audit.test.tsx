/** Every public map must expose linked OSM attribution, not inert credit text. */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";

const maplibre = vi.hoisted(() => ({
  attributionOptions: [] as Array<{ customAttribution?: string | string[] }>,
}));

vi.mock("maplibre-gl", () => {
  class MockMap {
    addControl() {
      return this;
    }

    on() {
      return this;
    }

    once() {
      return this;
    }

    getSource() {
      return undefined;
    }

    getCenter() {
      return { lat: 51.5, lng: -0.12 };
    }

    getZoom() {
      return 12;
    }

    remove() {}
  }

  class MockAttributionControl {
    constructor(options: { customAttribution?: string | string[] }) {
      maplibre.attributionOptions.push(options);
    }
  }

  class MockControl {
    on() {
      return this;
    }
  }

  return {
    default: {
      Map: MockMap,
      AttributionControl: MockAttributionControl,
      NavigationControl: MockControl,
      GeolocateControl: MockControl,
    },
  };
});

describe("Phase 0 map attribution", () => {
  it("gives MapLibre an OpenStreetMap copyright link", () => {
    const view = render(
      <MapView
        styleUrl="/map-style.json"
        initialCenter={{ lat: 51.5, lng: -0.12 }}
        initialZoom={12}
        placePins={[]}
        poiPins={[]}
      />,
    );

    try {
      const custom = maplibre.attributionOptions.at(-1)?.customAttribution;
      const html = Array.isArray(custom) ? custom.join(" ") : (custom ?? "");
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const link = holder.querySelector("a");

      expect(link, "MapLibre custom attribution must contain a real link").not.toBeNull();
      if (!link) return;
      expect(link).toHaveTextContent(/© OpenStreetMap contributors/i);
      expect(link).toHaveAttribute(
        "href",
        expect.stringMatching(/^https:\/\/(www\.)?openstreetmap\.org\/copyright/),
      );
    } finally {
      view.unmount();
      maplibre.attributionOptions.length = 0;
    }
  });
});
