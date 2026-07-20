import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { type ComponentType, createElement, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { MapCanvas } from "../../map/MapCanvas";
import { usePaneStore } from "../../state/pane";
import { useUiStore } from "../../state/ui";

const phase01 = vi.hoisted(() => ({ discover: vi.fn() }));

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
    onViewportChange?: (view: {
      bbox: { west: number; south: number; east: number; north: number };
      zoom: number;
      center: { lat: number; lng: number };
    }) => void;
  }) => {
    const fired = useRef(false);
    useEffect(() => {
      if (fired.current) return;
      fired.current = true;
      props.onViewportChange?.({
        bbox: { west: -10, south: 38, east: -8, north: 39 },
        zoom: 14,
        center: { lat: 38.7, lng: -9.1 },
      });
    }, [props.onViewportChange]);
    return <div data-testid="map-canvas" />;
  },
}));

beforeEach(() => {
  usePaneStore.setState({ pane: "collapsed" });
});

afterEach(() => {
  phase01.discover.mockReset();
  useUiStore.setState({ selection: null, pickerAt: null });
});

describe("Phase 1 bounded viewport discovery", () => {
  it("skips discovery below the configured minimum zoom and tells the user to zoom in", async () => {
    const repo = new DexieRepository(`phase01-low-zoom-${crypto.randomUUID()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useUiStore.setState({ selection: null, pickerAt: null });
    try {
      render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            RepoProvider as unknown as ComponentType<{ repo: DexieRepository }>,
            { repo },
            createElement(MapCanvas),
          ),
        ),
      );

      await waitFor(() => expect(screen.getByTestId("map-canvas")).toBeInTheDocument());
      expect(phase01.discover).not.toHaveBeenCalled();
      expect(screen.getByText(/zoom in.*places|places.*zoom in/i)).toBeInTheDocument();
    } finally {
      queryClient.clear();
      repo.db.close();
    }
  });
});
