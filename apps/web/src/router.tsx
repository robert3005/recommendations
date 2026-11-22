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
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useReviewingCount } from "./data/hooks";
import { ReviewPage } from "./features/interop/ReviewPage";
import { ListPage } from "./features/lists/ListPage";
import { ListsPage } from "./features/lists/ListsPage";
import { PlaceColumn, PlaceSheet } from "./features/place/PlaceSheet";
import { PostEditorPage } from "./features/posts/PostEditorPage";
import { PostPage } from "./features/posts/PostPage";
import { LivePublisher } from "./features/publish/LivePublisher";
import { AddPlaceField } from "./features/search/AddPlaceField";
import { SettingsPage } from "./features/settings/SettingsPage";
import { PublishedListView } from "./features/share/PublishedListView";
import { PublishedPostView } from "./features/share/PublishedPostView";
import { MapCanvas } from "./map/MapCanvas";
import { type DesktopPane, type SheetDetent, usePaneStore } from "./state/pane";
import { useSelectionStore } from "./state/projection";

/** Notebook geometry: mobile sheet detents × desktop split/collapsed. On md+
 *  the shell is a flex row — notebook, place column, canvas — so the notebook
 *  is the row's first column, not an overlay. */
function paneClasses(desktop: DesktopPane, sheet: SheetDetent, placeOpen: boolean): string {
  const base =
    "absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col rounded-t-crisp border-t border-hairline bg-paper " +
    "md:relative md:inset-auto md:order-1 md:h-full md:shrink-0 md:rounded-none md:border-t-0 md:border-r";
  const mobile = sheet === "peek" ? "h-14 overflow-hidden" : sheet === "half" ? "h-1/2" : "h-full";
  const desktopWidth = desktop === "collapsed" ? "md:hidden" : "md:w-[26rem]";
  // Tablet widths cannot hold notebook, place card and map side by side: the
  // card takes the notebook's column while a place is open, and closing it
  // brings the notebook back (spec/src/map-view.md §The grammar).
  const tablet = placeOpen ? "md:max-lg:hidden" : "";
  return `${base} ${mobile} ${desktopWidth} ${tablet}`;
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
  // Review is exposed only while an import needs it (2026-07-26 —
  // search-first chrome): the pill renders exactly while a batch is reviewing.
  const reviewCount = useReviewingCount() ?? 0;
  const placeOpen = useSelectionStore((s) => s.selectedPlaceId !== null) && !readOnly;
  const mode = usePaneStore((s) => s.mode);
  const desktop = usePaneStore((s) => s.desktop);
  const sheet = usePaneStore((s) => s.sheet);
  const setMode = usePaneStore((s) => s.setMode);
  const setDesktop = usePaneStore((s) => s.setDesktop);
  const collapse = usePaneStore((s) => s.collapse);
  const expand = usePaneStore((s) => s.expand);

  // The settings gear toggles: open remembers where it came from and makes
  // the notebook visible; a second press returns there.
  const appRouter = useRouter();
  const onSettings = pathname === "/settings";
  const settingsReturnTo = useRef("/");
  const toggleSettings = () => {
    if (onSettings) {
      appRouter.history.push(settingsReturnTo.current);
      return;
    }
    settingsReturnTo.current = pathname;
    if (desktop === "collapsed") setDesktop("split");
    appRouter.history.push("/settings");
  };

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
      {/* Live pages follow their source (spec/src/sharing.md §Live pages). */}
      {!readOnly ? <LivePublisher /> : null}
      {/* The persistent canvas: always mounted, never navigates. */}
      <div
        className={mapCanvasClasses()}
        data-testid="map-viewport"
        data-map-layout={desktop === "split" ? "beside-pane" : "full-bleed"}
      >
        <MapCanvas />
        {/* Collapsed notebook: a floating reopen affordance on the canvas.
            A lifted paper pill — solid paper, hairline, soft shadow — like
            every control floating over the map plate
            (spec/src/design.md §Map styling). */}
        {desktop === "collapsed" ? (
          <button
            type="button"
            data-testid="pane-reopen"
            onClick={() => setDesktop("split")}
            className="absolute bottom-16 left-3 z-10 hidden rounded-pill border border-hairline bg-paper px-3.5 py-1.5 text-sm font-medium text-ink shadow-lift md:block"
          >
            {readOnly ? "⟩ Shared page" : "⟩ Lists"}
          </button>
        ) : null}
      </div>

      {/* The notebook: where routes render. */}
      <div className={paneClasses(desktop, sheet, placeOpen)} data-testid="content-pane">
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
        {/* The top bar is for SEARCH: the wordmark home affordance, the search
            field filling the rest, the review pill only while an import batch
            is reviewing, the two pane steps, and Settings. Search results
            float below the whole bar, so they are readable on a phone. */}
        <header className="relative flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2.5 md:px-4">
          {readOnly ? (
            <div
              className="min-w-0 flex-1 font-display text-sm font-medium text-ink"
              data-testid="public-readonly-chrome"
            >
              Placemarks · Shared page
            </div>
          ) : (
            <>
              <Link
                to="/"
                data-testid="home-link"
                aria-label="Placemarks — home"
                className="shrink-0 font-display text-[15px] font-semibold tracking-tight text-ink"
              >
                {/* The phone gives the width to search: the wordmark shrinks
                    to its initial (spec/src/map-view.md §The grammar). */}
                <span
                  aria-hidden="true"
                  className="flex size-7 items-center justify-center rounded-pill bg-ink text-paper md:hidden"
                >
                  P
                </span>
                <span className="hidden md:inline">Placemarks</span>
              </Link>
              <div className="min-w-0 flex-1">
                <AddPlaceField onShowAll={() => void appRouter.navigate({ to: "/" })} />
              </div>
              {reviewCount > 0 ? (
                <Link
                  to="/review"
                  data-testid="review-pill"
                  className="shrink-0 rounded-full border border-hairline bg-panel px-2.5 py-1 text-xs font-medium text-ink"
                >
                  Review {reviewCount}
                </Link>
              ) : null}
            </>
          )}
          {/* One step toward the map / toward the content — the map is one
              collapse away, never a tab switch. A step that cannot be taken is
              not drawn: the width goes to search. */}
          <button
            type="button"
            aria-label="Show more map"
            title="Show more map"
            data-testid="pane-collapse"
            disabled={atMapEnd}
            onClick={collapse}
            className="flex size-7 shrink-0 items-center justify-center rounded-pill border border-hairline text-xs text-ink hover:bg-hover disabled:hidden"
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
            className="flex size-7 shrink-0 items-center justify-center rounded-pill border border-hairline text-xs text-ink hover:bg-hover disabled:hidden"
          >
            ⟩
          </button>
          {/* Settings sits in the top bar, so nothing floats over the page. */}
          {!readOnly ? (
            <button
              type="button"
              aria-label="Settings"
              aria-pressed={onSettings}
              data-testid="settings-gear"
              onClick={toggleSettings}
              className={`flex size-7 shrink-0 items-center justify-center rounded-pill border border-hairline text-sm ${
                onSettings ? "bg-ink text-paper" : "text-ink hover:bg-hover"
              }`}
            >
              <span aria-hidden="true">⚙</span>
            </button>
          ) : null}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto pb-6" data-testid="pane-outlet">
          <Outlet />
        </main>
      </div>

      {/* Selection belongs to the notebook grammar, not the map's stacking
          context (spec/src/map-view.md §The place card): on desktop the card
          rises as its own vertical — a column between the notebook and the
          canvas, present even while the notebook is collapsed; on mobile a
          bottom sheet that stays visible when the sheet covers the map. */}
      {!readOnly ? mode === "desktop" ? <PlaceColumn /> : <PlaceSheet /> : null}

      {/* While the desktop notebook is collapsed its top bar is gone, so the
          gear floats on the canvas under the reopen chip; opening Settings
          from there expands the notebook back to split. */}
      {!readOnly && mode === "desktop" && desktop === "collapsed" ? (
        <button
          type="button"
          aria-label="Settings"
          aria-pressed={onSettings}
          data-testid="settings-gear-floating"
          onClick={toggleSettings}
          className="absolute bottom-3 left-3 z-30 rounded-pill border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink shadow-lift"
        >
          <span aria-hidden="true">⚙</span>
        </button>
      ) : null}
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
