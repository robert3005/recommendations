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
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { SettingsPage } from "./features/backup/SettingsPage";
import { ReviewPage } from "./features/interop/ReviewPage";
import { ListPage } from "./features/lists/ListPage";
import { ListsPage } from "./features/lists/ListsPage";
import { PlaceSheet } from "./features/place/PlaceSheet";
import { PostEditorPage } from "./features/posts/PostEditorPage";
import { PostPage } from "./features/posts/PostPage";
import { HostedPostViewerPage } from "./features/share/HostedPostViewerPage";
import { HostedViewerPage } from "./features/share/HostedViewerPage";
import { SnapshotViewerPage } from "./features/share/SnapshotViewerPage";
import { MapCanvas } from "./map/MapCanvas";
import { type PaneState, usePaneStore } from "./state/pane";

/** Pane geometry per state — desktop panel widths / mobile sheet detents. */
function paneClasses(pane: PaneState): string {
  const base =
    "absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col rounded-t-2xl border-t border-rule bg-paper shadow-2xl " +
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
  return pathname === "/l" || pathname.startsWith("/l/") || pathname.startsWith("/p/");
}

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const _navigate = useNavigate();
  const readOnly = isPublicViewerPath(pathname);
  const pane = usePaneStore((s) => s.pane);
  const setPane = usePaneStore((s) => s.setPane);
  const collapse = usePaneStore((s) => s.collapse);
  const expand = usePaneStore((s) => s.expand);
  return (
    <div className="relative h-full overflow-hidden" data-testid="app-shell" data-pane-state={pane}>
      {/* The persistent canvas: always mounted, never navigates. */}
      <div
        className={mapCanvasClasses(pane)}
        data-testid="map-viewport"
        data-map-layout={pane === "split" ? "beside-pane" : "full-bleed"}
      >
        <MapCanvas readOnly={readOnly} />
      </div>

      {/* The content pane: where routes render. */}
      <div className={paneClasses(pane)} data-testid="content-pane">
        {/* One detent per tap. A hand-rolled pointer-drag re-implemented what a
            sheet library does, in ~70 lines of arithmetic, for a gesture whose
            whole job is to pick one of three states — and a button is keyboard
            operable, which the drag never was. */}
        <button
          type="button"
          aria-label={pane === "expanded" ? "Show the map" : "Show more content"}
          data-testid="pane-drag-handle"
          className="flex h-5 shrink-0 items-center justify-center md:hidden"
          onClick={() => (pane === "expanded" ? collapse() : expand())}
        >
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-rule" />
        </button>
        <header className="flex shrink-0 items-center gap-1 border-b border-land px-3 py-2">
          {readOnly ? (
            <div
              className="min-w-0 flex-1 text-sm font-medium text-ink-2"
              data-testid="public-readonly-chrome"
            >
              Placemarks · Shared page
            </div>
          ) : (
            <nav aria-label="Primary" className="flex min-w-0 flex-1 items-center gap-1">
              <Link
                to="/"
                className="rounded px-2.5 py-1 text-sm font-medium text-ink-2 [&.active]:bg-rule"
              >
                Lists
              </Link>
              <Link
                to="/review"
                className="rounded px-2.5 py-1 text-sm font-medium text-ink-2 [&.active]:bg-rule"
              >
                Review
              </Link>
              <Link
                to="/settings"
                className="rounded px-2.5 py-1 text-sm font-medium text-ink-2 [&.active]:bg-rule"
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
            className="rounded px-2 py-1 text-sm text-ink-2 hover:bg-land disabled:opacity-30"
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
            className="rounded px-2 py-1 text-sm text-ink-2 hover:bg-land disabled:opacity-30"
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
          className="absolute bottom-16 left-3 z-10 hidden rounded-full bg-paper/95 px-3 py-1.5 text-sm font-medium text-ink shadow md:block"
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

export const routeTree = rootRoute.addChildren([
  homeRoute,
  listRoute,
  postRoute,
  postEditorRoute,
  reviewRoute,
  settingsRoute,
  snapshotRoute,
  hostedRoute,
  hostedPostRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
