/**
 * Smoke: every notebook route renders against a real Dexie repository —
 * seeded AND empty — without throwing. This is the dev-server "does the page
 * come up" check; a render crash on any route (the stale-db marker.shape
 * incident) fails here, not at `pnpm dev`.
 *
 * The map canvas is stubbed: MapLibre needs a real browser (Playwright owns
 * that); this test owns the notebook side of every route.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../data/RepoContext";
import { DexieRepository } from "../data/repo";
import { routeTree } from "../router";

vi.mock("../map/MapCanvas", () => ({
  MapCanvas: () => <div data-testid="map-canvas-stub" />,
}));

const NOW = "2026-07-26T12:00:00.000Z";
let counter = 0;

async function seededRepo() {
  counter += 1;
  const repo = new DexieRepository(`smoke-${Date.now()}-${counter}`);
  const list = await repo.createList("Lisbon eats");
  const added = await repo.addToList(list.id, {
    kind: "new",
    facts: { name: "Café Central", lat: 38.7139, lng: -9.1394, origin: "search" },
  });
  if (added.status !== "added") throw new Error("seed failed");
  const listPost = await repo.createPost({ kind: "list", listId: list.id }, "A weekend of eating");
  await repo.updatePost(listPost.id, {
    body: `Start at [Café Central](place:${added.place.id}).`,
  });
  await repo.createPost({ kind: "place", placeId: added.place.id }, "Café Central deep dive");
  return { repo, list, place: added.place, post: listPost };
}

async function renderRoute(repo: DexieRepository, path: string, expectTestId: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RepoProvider repo={repo}>
        <RouterProvider router={router} />
      </RepoProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByTestId(expectTestId, {}, { timeout: 5000 })).toBeInTheDocument();
  view.unmount();
}

describe("route smoke — seeded library", () => {
  it("renders every route", async () => {
    const { repo, list, post } = await seededRepo();
    await renderRoute(repo, "/", "lists-page");
    await renderRoute(repo, `/list/${list.id}`, "list-page");
    await renderRoute(repo, `/post/${post.id}`, "post-page");
    await renderRoute(repo, `/post/${post.id}/edit`, "post-editor");
    await renderRoute(repo, "/review", "review-page");
    await renderRoute(repo, "/settings", "settings-page");
    // Public viewers: an unknown slug renders the designed error state.
    await renderRoute(repo, "/l/no-such-list", "published-error");
    await renderRoute(repo, "/p/no-such-post", "published-error");
  });
});

describe("route smoke — empty library", () => {
  it("first-launch routes render with nothing seeded", async () => {
    counter += 1;
    const repo = new DexieRepository(`smoke-empty-${Date.now()}-${counter}`);
    await renderRoute(repo, "/", "lists-page");
    await renderRoute(repo, "/review", "review-page");
    await renderRoute(repo, "/settings", "settings-page");
  });
});
