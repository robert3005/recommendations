/**
 * One layout grammar (spec/src/map-view.md §The grammar): every route renders
 * into the NOTEBOOK beside the single persistent MAP CANVAS — a singleton in
 * the app shell, outside the route outlet. Desktop: notebook split (default)
 * or collapsed (full-bleed map). Mobile: the notebook is a sheet over the
 * canvas with peek/half/full detents. The notebook opens on the lists.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { ReviewPage } from "./features/interop/ReviewPage";
import { ListPage } from "./features/lists/ListPage";
import { ListsPage } from "./features/lists/ListsPage";
import { PlaceColumn, PlaceSheet } from "./features/place/PlaceSheet";
import { PostEditorPage } from "./features/posts/PostEditorPage";
import { PostPage } from "./features/posts/PostPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { PublishedListView } from "./features/share/PublishedListView";
import { PublishedPostView } from "./features/share/PublishedPostView";
import { MapCanvas } from "./map/MapCanvas";
import { type DesktopPane, type SheetDetent, usePaneStore } from "./state/pane";

/** Notebook geometry: mobile sheet detents × desktop split/collapsed. On md+
 *  the shell is a flex row — notebook, place column, canvas — so the notebook
 *  is the row's first column, not an overlay. */
function paneClasses(desktop: DesktopPane, sheet: SheetDetent): string {
  const base =
    "absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col rounded-t-crisp border-t border-hairline bg-paper " +
    "md:relative md:inset-auto md:order-1 md:h-full md:shrink-0 md:rounded-none md:border-t-0 md:border-r";
  const mobile = sheet === "peek" ? "h-14 overflow-hidden" : sheet === "half" ? "h-1/2" : "h-full";
  const desktopWidth = desktop === "collapsed" ? "md:hidden" : "md:w-[26rem]";
  return `${base} ${mobile} ${desktopWidth}`;
}

/** Desktop is true sibling geometry: the canvas is the row's flexible last
 *  column — it shrinks beside the notebook and the place column, never an
 *  overlay on md+. */
export function mapCanvasClasses(): string {
  return "absolute inset-0 md:relative md:inset-auto md:order-3 md:h-full md:min-w-0 md:flex-1";
}

export function isPublicViewerPath(pathname: string): boolean {
  return pathname.startsWith("/l/") || pathname.startsWith("/p/");
}

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const readOnly = isPublicViewerPath(pathname);
  const mode = usePaneStore((s) => s.mode);
  const desktop = usePaneStore((s) => s.desktop);
  const sheet = usePaneStore((s) => s.sheet);
  const setMode = usePaneStore((s) => s.setMode);
  const setDesktop = usePaneStore((s) => s.setDesktop);
  const collapse = usePaneStore((s) => s.collapse);
  const expand = usePaneStore((s) => s.expand);

  // The shell owns the form-factor switch: pane geometry follows the same
  // breakpoint the CSS uses (md = 768px).
  useEffect(() => {
    const query = window.matchMedia?.("(min-width: 768px)");
    if (!query) return;
    const apply = () => setMode(query.matches ? "desktop" : "mobile");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [setMode]);

  const atMapEnd = mode === "desktop" ? desktop === "collapsed" : sheet === "peek";
  const atContentEnd = mode === "desktop" ? desktop === "split" : sheet === "full";

  return (
    <div
      className="relative h-full overflow-hidden md:flex"
      data-testid="app-shell"
      data-pane-state={desktop}
      data-sheet-detent={sheet}
    >
      {/* The persistent canvas: always mounted, never navigates. */}
      <div
        className={mapCanvasClasses()}
        data-testid="map-viewport"
        data-map-layout={desktop === "split" ? "beside-pane" : "full-bleed"}
      >
        <MapCanvas />
        {/* Collapsed notebook: a floating reopen affordance on the canvas.
            A deep-green chip — solid paper with a hairline — so every control
            floating over the light map plate reads as console chrome
            (spec/src/design.md §Map styling). */}
        {desktop === "collapsed" ? (
          <button
            type="button"
            data-testid="pane-reopen"
            onClick={() => setDesktop("split")}
            className="absolute bottom-16 left-3 z-10 hidden rounded-crisp border border-hairline bg-paper px-3 py-1.5 text-sm font-medium text-ink md:block"
          >
            {readOnly ? "⟩ Shared page" : "⟩ Lists"}
          </button>
        ) : null}
      </div>

      {/* The notebook: where routes render. */}
      <div className={paneClasses(desktop, sheet)} data-testid="content-pane">
        {/* One detent per tap — a button is keyboard operable; dismissal is
            never gesture-only (spec/src/map-view.md §Accessibility). */}
        <button
          type="button"
          aria-label={sheet === "full" ? "Show the map" : "Show more content"}
          data-testid="pane-drag-handle"
          className="flex h-5 shrink-0 items-center justify-center md:hidden"
          onClick={() => (sheet === "full" ? collapse() : expand())}
        >
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-hairline" />
        </button>
        <header className="flex shrink-0 items-center gap-1 border-b border-hairline px-3 py-2">
          {readOnly ? (
            <div
              className="min-w-0 flex-1 font-display text-sm font-medium text-ink"
              data-testid="public-readonly-chrome"
            >
              Placemarks · Shared page
            </div>
          ) : (
            <nav aria-label="Primary" className="flex min-w-0 flex-1 items-center gap-1">
              <Link
                to="/"
                className="rounded-crisp px-2.5 py-1 text-sm font-medium text-ink [&.active]:bg-ink/10"
              >
                Lists
              </Link>
              <Link
                to="/review"
                className="rounded-crisp px-2.5 py-1 text-sm font-medium text-ink [&.active]:bg-ink/10"
              >
                Review
              </Link>
              <Link
                to="/settings"
                className="rounded-crisp px-2.5 py-1 text-sm font-medium text-ink [&.active]:bg-ink/10"
              >
                Settings
              </Link>
            </nav>
          )}
          {/* One step toward the map / toward the content — the map is one
              collapse away, never a tab switch. */}
          <button
            type="button"
            aria-label="Show more map"
            title="Show more map"
            data-testid="pane-collapse"
            disabled={atMapEnd}
            onClick={collapse}
            className="rounded-crisp px-2 py-1 text-sm text-ink hover:bg-ink/10 disabled:opacity-30"
          >
            ⟨
          </button>
          <button
            type="button"
            aria-label="Show more content"
            title="Show more content"
            data-testid="pane-expand"
            disabled={atContentEnd}
            onClick={expand}
            className="rounded-crisp px-2 py-1 text-sm text-ink hover:bg-ink/10 disabled:opacity-30"
          >
            ⟩
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto" data-testid="pane-outlet">
          <Outlet />
        </main>
      </div>

      {/* Selection belongs to the notebook grammar, not the map's stacking
          context (spec/src/map-view.md §The place card): on desktop the card
          rises as its own vertical — a column between the notebook and the
          canvas, present even while the notebook is collapsed; on mobile a
          bottom sheet that stays visible when the sheet covers the map. */}
      {!readOnly ? mode === "desktop" ? <PlaceColumn /> : <PlaceSheet /> : null}
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

// The lists are the home (spec/src/map-view.md §Home).
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

// Posts (spec/src/posts.md): reading, and the Markdown editor.
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

// The import review queue is a notebook route; the item under review projects
// onto the canvas (spec/src/interop.md §The review queue).
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

// Public viewers (spec/src/sharing.md): published documents under named slugs.
const publishedListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/l/$slug",
  component: PublishedListView,
});

const publishedPostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug",
  component: PublishedPostView,
});

export const routeTree = rootRoute.addChildren([
  homeRoute,
  listRoute,
  postRoute,
  postEditorRoute,
  reviewRoute,
  settingsRoute,
  publishedListRoute,
  publishedPostRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
