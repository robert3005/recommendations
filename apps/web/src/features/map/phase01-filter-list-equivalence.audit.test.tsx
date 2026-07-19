/**
 * Phase 0/1 map accessibility contract: detailed OSM categories are exposed
 * through the six top-level filter chips, and every canvas result has an
 * equivalent keyboard/screen-reader representation.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../state/ui";
import { MapPage } from "./MapPage";

const phase01 = vi.hoisted(() => ({
  capturedPoiPins: [] as Array<{ name: string; category: string }>,
  discover: vi.fn(async () => ({
    truncated: false,
    pois: [
      {
        osmRef: { type: "node" as const, id: "101" },
        name: "Accessible Café",
        category: "cafe",
        lat: 51.5,
        lng: -0.12,
        resolvedAt: "2026-07-19T12:00:00.000Z",
      },
      {
        osmRef: { type: "node" as const, id: "102" },
        name: "Neighbourhood Bar",
        category: "bar",
        lat: 51.5001,
        lng: -0.1201,
        resolvedAt: "2026-07-19T12:00:00.000Z",
      },
    ],
  })),
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
    discover: phase01.discover,
  },
}));

vi.mock("../../map/MapView", () => ({
  MapView: (props: {
    poiPins: Array<{ name: string; category: string }>;
    onViewportChange?: (view: {
      bbox: { west: number; south: number; east: number; north: number };
      zoom: number;
      center: { lat: number; lng: number };
    }) => void;
  }) => {
    phase01.capturedPoiPins = props.poiPins;
    const fired = useRef(false);
    useEffect(() => {
      if (fired.current) return;
      fired.current = true;
      props.onViewportChange?.({
        bbox: { west: -0.13, south: 51.49, east: -0.11, north: 51.51 },
        zoom: 16,
        center: { lat: 51.5, lng: -0.12 },
      });
    }, [props.onViewportChange]);
    return <div data-testid="map-canvas" />;
  },
}));

vi.mock("../place/PlaceSheet", () => ({ PlaceSheet: () => null }));
vi.mock("../search/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../picker/CandidatePicker", () => ({ CandidatePicker: () => null }));
vi.mock("../picker/ManualPinDialog", () => ({ ManualPinDialog: () => null }));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MapPage />
    </QueryClientProvider>,
  );
  return { queryClient, view };
}

function filterControl(name: string): HTMLElement | null {
  return (
    screen.queryByRole("button", { name }) ??
    screen.queryByRole("checkbox", { name }) ??
    screen.queryByRole("switch", { name })
  );
}

function placeControl(name: RegExp): HTMLElement | null {
  return (
    screen.queryByRole("button", { name }) ??
    screen.queryByRole("link", { name }) ??
    screen.queryByRole("option", { name })
  );
}

function accessibleContent(element: HTMLElement): string {
  const descriptions = (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  return `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""} ${descriptions}`;
}

afterEach(() => {
  phase01.discover.mockClear();
  phase01.capturedPoiPins = [];
  useUiStore.setState({ selection: null, pickerAt: null });
});

describe("Phase 0/1 category filters and non-map equivalence", () => {
  it("maps detailed OSM categories into the adopted top-level filter chips", async () => {
    const { queryClient, view } = renderPage();
    try {
      await waitFor(() => expect(phase01.capturedPoiPins).toHaveLength(2));

      for (const label of ["Eat", "Drink", "Shop", "Stay", "Culture", "Health"]) {
        expect.soft(filterControl(label), `missing keyboard-operable ${label} chip`).not.toBeNull();
      }

      const eat = filterControl("Eat");
      if (!eat) throw new Error("missing keyboard-operable Eat chip");
      await userEvent.click(eat);
      await waitFor(() =>
        expect(phase01.capturedPoiPins.map((pin) => pin.name)).toEqual(["Accessible Café"]),
      );
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("provides an interactive non-canvas representation of every discovered POI", async () => {
    const { queryClient, view } = renderPage();
    try {
      await waitFor(() => expect(phase01.capturedPoiPins).toHaveLength(2));

      const cafe = placeControl(/Accessible Café/i);
      const bar = placeControl(/Neighbourhood Bar/i);
      expect(cafe).not.toBeNull();
      expect(bar).not.toBeNull();
      if (!cafe || !bar) throw new Error("missing interactive non-map POI representation");
      expect(accessibleContent(cafe)).toMatch(/cafe/i);
      expect(accessibleContent(bar)).toMatch(/bar/i);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});
