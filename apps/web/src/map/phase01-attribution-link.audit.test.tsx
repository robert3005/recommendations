/** Every public map must expose linked OSM attribution, not inert credit text. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";

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
    resize() {}
    triggerRepaint() {}
  }

  class MockAttributionControl {}

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
  it("keeps an OpenStreetMap copyright link on the map before its style loads", () => {
    const view = render(
      <MapView
        styleUrl="/map-style.json"
        initialCenter={{ lat: 51.5, lng: -0.12 }}
        initialZoom={12}
        placePins={[]}
      />,
    );

    try {
      const link = screen.getByTestId("map-attribution");
      expect(link).toHaveTextContent(/© OpenStreetMap contributors/i);
      expect(link).toHaveAttribute(
        "href",
        expect.stringMatching(/^https:\/\/(www\.)?openstreetmap\.org\/copyright/),
      );
    } finally {
      view.unmount();
    }
  });
});
