/**
 * One layout grammar (spec/src/map-view.md §The grammar): every route renders
 * into the CONTENT PANE beside the single persistent MAP CANVAS — a singleton
 * in the app shell, outside the route outlet. Desktop splits pane/canvas;
 * mobile floats the pane as a detented sheet over the map. Launch opens the
 * pane expanded on the Lists home; the map is one collapse away, never a tab
 * switch. At full scale the canvas idles.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  retainSearchParams,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useRef, useState } from "react";
import { SettingsPage } from "./features/backup/SettingsPage";
import { ReviewPage } from "./features/interop/ReviewPage";
import { ListPage } from "./features/lists/ListPage";
import { ListsPage } from "./features/lists/ListsPage";
import { PlaceSheet } from "./features/place/PlaceSheet";
import { PostEditorPage } from "./features/posts/PostEditorPage";
import { PostPage } from "./features/posts/PostPage";
import { HostedPostViewerPage } from "./features/share/HostedPostViewerPage";
import { HostedViewerPage } from "./features/share/HostedViewerPage";
import { NoteViewerPage } from "./features/share/NoteViewerPage";
import { SnapshotViewerPage } from "./features/share/SnapshotViewerPage";
import { MapCanvas } from "./map/MapCanvas";
import { type PaneState, usePaneStore } from "./state/pane";

export interface ViewportRouteSearch {
  lat?: number;
  lng?: number;
  zoom?: number;
}

function finiteSearchNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Validate the camera carried by every typed route; partial/unsafe cameras are discarded. */
export function validateViewportSearch(search: Record<string, unknown>): ViewportRouteSearch {
  const lat = finiteSearchNumber(search.lat);
  const lng = finiteSearchNumber(search.lng);
  const zoom = finiteSearchNumber(search.zoom);
  if (
    lat === undefined ||
    lng === undefined ||
    zoom === undefined ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180 ||
    zoom < 0 ||
    zoom > 24
  ) {
    return {};
  }
  return { lat, lng, zoom };
}

/** Pane geometry per state — desktop panel widths / mobile sheet detents. */
function paneClasses(pane: PaneState): string {
  const base =
    "absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col rounded-t-2xl border-t border-stone-200 bg-white shadow-2xl " +
    "md:inset-x-auto md:left-0 md:top-0 md:h-full md:rounded-none md:border-t-0 md:border-r";
  if (pane === "collapsed") {
    // Peek: a slim handle strip on mobile; hidden entirely on desktop.
    return `${base} h-14 overflow-hidden md:hidden`;
  }
  if (pane === "split") {
    return `${base} h-1/2 md:h-full md:w-[26rem]`;
  }
  // Expanded / full: the reading-writing surface; the canvas idles beneath.
  return `${base} h-full rounded-none md:w-full`;
}

/** Desktop split is true sibling geometry: the canvas starts after the pane. */
export function mapCanvasClasses(pane: PaneState): string {
  return `absolute inset-0 ${pane === "split" ? "md:left-[26rem]" : ""}`.trim();
}

export function isPublicViewerPath(pathname: string): boolean {
  return (
    pathname === "/l" ||
    pathname.startsWith("/l/") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/n/")
  );
}

const PEEK_HEIGHT = 56;

export function paneStateAtHeight(height: number, viewportHeight: number): PaneState {
  const detents: { pane: PaneState; height: number }[] = [
    { pane: "collapsed", height: PEEK_HEIGHT },
    { pane: "split", height: viewportHeight / 2 },
    { pane: "expanded", height: viewportHeight },
  ];
  return detents.reduce((closest, candidate) =>
    Math.abs(candidate.height - height) < Math.abs(closest.height - height) ? candidate : closest,
  ).pane;
}

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const routeViewport = useRouterState({ select: (state) => state.location.search });
  const navigate = useNavigate();
  // The persistent root shell is not a concrete leaf route, so TanStack
  // cannot infer `from` for a search-only replace. The root route validator
  // remains the typed boundary; this adapter preserves whichever leaf is open.
  const replaceRouteViewport = navigate as unknown as (options: {
    replace: true;
    resetScroll: false;
    search: (current: ViewportRouteSearch) => ViewportRouteSearch;
  }) => Promise<unknown>;
  const readOnly = isPublicViewerPath(pathname);
  const pane = usePaneStore((s) => s.pane);
  const setPane = usePaneStore((s) => s.setPane);
  const collapse = usePaneStore((s) => s.collapse);
  const expand = usePaneStore((s) => s.expand);
  const dragRef = useRef<
    | {
        pointerId: number;
        startY: number;
        startHeight: number;
        lastHeight: number;
      }
    | undefined
  >(undefined);
  const [dragHeight, setDragHeight] = useState<number>();
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (window.matchMedia?.("(min-width: 768px)").matches) return;
    const viewportHeight = window.innerHeight;
    const startHeight =
      pane === "collapsed" ? PEEK_HEIGHT : pane === "split" ? viewportHeight / 2 : viewportHeight;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      lastHeight: startHeight,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const height = Math.max(
      PEEK_HEIGHT,
      Math.min(window.innerHeight, drag.startHeight + drag.startY - event.clientY),
    );
    drag.lastHeight = height;
    setDragHeight(height);
  };
  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!cancelled) setPane(paneStateAtHeight(drag.lastHeight, window.innerHeight));
    dragRef.current = undefined;
    setDragHeight(undefined);
  };
  return (
    <div className="relative h-full overflow-hidden" data-testid="app-shell" data-pane-state={pane}>
      {/* The persistent canvas: always mounted, never navigates. */}
      <div
        className={mapCanvasClasses(pane)}
        data-testid="map-viewport"
        data-map-layout={pane === "split" ? "beside-pane" : "full-bleed"}
      >
        <MapCanvas
          readOnly={readOnly}
          routeViewport={routeViewport}
          onRouteViewportChange={(next) => {
            if (
              routeViewport.lat === next.lat &&
              routeViewport.lng === next.lng &&
              routeViewport.zoom === next.zoom
            ) {
              return;
            }
            void replaceRouteViewport({
              replace: true,
              resetScroll: false,
              search: (current) => ({ ...current, ...next }),
            });
          }}
        />
      </div>

      {/* The content pane: where routes render. */}
      <div
        className={paneClasses(pane)}
        data-testid="content-pane"
        style={dragHeight === undefined ? undefined : { height: `${dragHeight.toString()}px` }}
      >
        <button
          type="button"
          aria-label="Drag content pane"
          data-testid="pane-drag-handle"
          className="flex h-5 shrink-0 touch-none items-center justify-center md:hidden"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
        >
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-stone-300" />
        </button>
        <header className="flex shrink-0 items-center gap-1 border-b border-stone-100 px-3 py-2">
          {readOnly ? (
            <div
              className="min-w-0 flex-1 text-sm font-medium text-stone-700"
              data-testid="public-readonly-chrome"
            >
              Placemarks · Shared page
            </div>
          ) : (
            <nav aria-label="Primary" className="flex min-w-0 flex-1 items-center gap-1">
              <Link
                to="/"
                className="rounded px-2.5 py-1 text-sm font-medium text-stone-700 [&.active]:bg-stone-200"
              >
                Lists
              </Link>
              <Link
                to="/review"
                className="rounded px-2.5 py-1 text-sm font-medium text-stone-700 [&.active]:bg-stone-200"
              >
                Review
              </Link>
              <Link
                to="/settings"
                className="rounded px-2.5 py-1 text-sm font-medium text-stone-700 [&.active]:bg-stone-200"
              >
                Settings
              </Link>
            </nav>
          )}
          {/* Pane detents: collapse toward the map, expand toward the content —
              keyboard-operable, never gesture-only (spec/src/map-view.md). */}
          <button
            type="button"
            aria-label="Show more map"
            title="Show more map"
            data-testid="pane-collapse"
            disabled={pane === "collapsed"}
            onClick={collapse}
            className="rounded px-2 py-1 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-30"
          >
            ⟨
          </button>
          <button
            type="button"
            aria-label="Show more content"
            title="Show more content"
            data-testid="pane-expand"
            disabled={pane === "expanded"}
            onClick={expand}
            className="rounded px-2 py-1 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-30"
          >
            ⟩
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto" data-testid="pane-outlet">
          <Outlet />
        </main>
      </div>

      {/* Collapsed pane: a floating reopen affordance on the canvas. */}
      {pane === "collapsed" ? (
        <button
          type="button"
          data-testid="pane-reopen"
          onClick={() => setPane("split")}
          className="absolute bottom-16 left-3 z-10 hidden rounded-full bg-white/95 px-3 py-1.5 text-sm font-medium text-stone-800 shadow md:block"
        >
          {readOnly ? "⟩ Shared page" : "⟩ Lists"}
        </button>
      ) : null}

      {/* Selection belongs to the pane grammar, not the map's stacking
          context. It therefore stays visible when the pane covers the map. */}
      {!readOnly ? <PlaceSheet /> : null}
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  validateSearch: validateViewportSearch,
  search: {
    middlewares: [retainSearchParams(["lat", "lng", "zoom"])],
  },
});

// The Lists home is the pane's `/` route and launch state (spec/src/map-view.md).
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ListsPage,
});

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/list/$listId",
  component: ListPage,
});

// Pre-pivot paths stay reachable.
const legacyListsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lists",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

const legacyListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lists/$listId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/list/$listId", params: { listId: params.listId } });
  },
});

// Posts — the editorial layer (spec/src/posts.md): reading beside the
// following canvas, and the block editor beside the candidate-dimmed canvas.
const postRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/post/$postId",
  component: PostPage,
});

const postEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/post/$postId/edit",
  component: PostEditorPage,
});

// The import review queue is a pane route; the item under review projects
// onto the main canvas (spec/src/interop.md §Import queue model).
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review",
  component: ReviewPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

// Public share viewers (spec/src/sharing.md): snapshot links live in the
// fragment; hosted links live under a public slug.
const snapshotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/l",
  component: SnapshotViewerPage,
});

const hostedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/l/$slug",
  component: HostedViewerPage,
});

const hostedPostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug",
  component: HostedPostViewerPage,
});

const noteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/n/$slug",
  component: NoteViewerPage,
});

export const routeTree = rootRoute.addChildren([
  homeRoute,
  listRoute,
  legacyListsRoute,
  legacyListRoute,
  postRoute,
  postEditorRoute,
  reviewRoute,
  settingsRoute,
  snapshotRoute,
  hostedRoute,
  hostedPostRoute,
  noteRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
