import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { type ComponentType, createElement } from "react";
import { expect, test, vi } from "vitest";
import { RepoProvider } from "../data/RepoContext";
import { DexieRepository } from "../data/repo";
import { MapPage } from "../features/map/MapPage";
import { PlaceSheet } from "../features/place/PlaceSheet";
import { server } from "../mocks/server";
import { OsmApiResolver } from "../providers/osmApi";
import { useUiStore } from "../state/ui";

const phase01 = vi.hoisted(() => ({ discover: vi.fn() }));

vi.mock("../providers", () => ({
  searchProvider: { search: vi.fn(async () => []) },
  poiResolver: {
    resolveExact: vi.fn(async (ref: { id: string }) =>
      ref.id === "410" ? { type: "gone" } : { type: "error" },
    ),
    searchNearby: vi.fn(async () => []),
    discover: phase01.discover,
  },
}));

vi.mock("../map/MapView", async () => {
  const { createElement: element, useEffect, useRef } = await import("react");
  type Props = {
    onViewportChange?: (view: {
      bbox: { west: number; south: number; east: number; north: number };
      zoom: number;
      center: { lat: number; lng: number };
    }) => void;
  };
  return {
    MapView: (props: Props) => {
      const fired = useRef(false);
      useEffect(() => {
        if (fired.current) return;
        fired.current = true;
        props.onViewportChange?.({
          bbox: { west: -9.145, south: 38.71, east: -9.135, north: 38.717 },
          zoom: 16,
          center: { lat: 38.7139, lng: -9.1394 },
        });
      }, [props.onViewportChange]);
      return element("div", { "data-testid": "map-canvas" });
    },
  };
});

test("a production build fails closed when required provider configuration is absent", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-phase01-build-"));
  // Typed loosely: vite's ambient `process.env` typing has no index signature.
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "production" };
  for (const key of [
    "VITE_MAP_STYLE_URL",
    "VITE_PHOTON_URL",
    "VITE_OSM_API_URL",
    "VITE_OVERPASS_URL",
    "VITE_ENABLE_MSW",
    "PLACEMARKS_STORYBOOK",
  ]) {
    delete env[key];
  }

  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/provider|VITE_/i);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);

test("the Storybook static build does not require production provider credentials", () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-phase01-storybook-"));
  const env = { ...process.env };
  for (const key of [
    "VITE_MAP_STYLE_URL",
    "VITE_PHOTON_URL",
    "VITE_OSM_API_URL",
    "VITE_OVERPASS_URL",
    "PLACEMARKS_STORYBOOK",
  ]) {
    delete env[key];
  }

  try {
    const result = spawnSync("pnpm", ["exec", "storybook", "build", "--output-dir", outDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

    expect(result.status, output).toBe(0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);

test("a successful exact-response without the requested element is unavailable, not gone", async () => {
  const baseUrl = "https://phase01-resolver.test";
  server.use(
    http.get(`${baseUrl}/api/0.6/node/42.json`, () =>
      HttpResponse.json({ version: "0.6", elements: [] }),
    ),
  );

  const outcome = await new OsmApiResolver(baseUrl).resolveExact({ type: "node", id: "42" });

  expect(outcome).toEqual({ type: "error" });
});

test("a confirmed-deleted element keeps the documented recovery affordances", async () => {
  const repo = new DexieRepository(`phase01-gone-${crypto.randomUUID()}`);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUiStore.setState({
    selection: {
      kind: "osm",
      ref: { type: "node", id: "410" },
      hint: { name: "Closed Café", lat: 38.71, lng: -9.14 },
    },
  });

  try {
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          RepoProvider as unknown as ComponentType<{ repo: DexieRepository }>,
          { repo },
          createElement(PlaceSheet),
        ),
      ),
    );
    await screen.findByTestId("sheet-gone");

    expect.soft(screen.queryByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect
      .soft(screen.queryByRole("button", { name: /candidate|nearby|match/i }))
      .toBeInTheDocument();
    expect.soft(screen.queryByTestId("osm-link")).toBeInTheDocument();
  } finally {
    queryClient.clear();
    repo.db.close();
    useUiStore.setState({ selection: null });
  }
});

test("a viewport-discovery failure exposes an error state on the map surface", async () => {
  phase01.discover.mockReset().mockRejectedValue(new Error("resolver unavailable"));
  const repo = new DexieRepository(`phase01-discovery-${crypto.randomUUID()}`);
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
          createElement(MapPage),
        ),
      ),
    );
    await waitFor(() => expect(phase01.discover).toHaveBeenCalledOnce());

    expect(
      await screen.findByText(
        /places?.*(unavailable|could not|couldn't|failed|offline)|(unavailable|could not|couldn't|failed|offline).*places?/i,
      ),
    ).toBeInTheDocument();
  } finally {
    queryClient.clear();
    repo.db.close();
  }
});
