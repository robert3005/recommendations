import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { SettingsPage } from "./features/backup/SettingsPage";
import { ListPage } from "./features/lists/ListPage";
import { ListsPage } from "./features/lists/ListsPage";
import { MapPage } from "./features/map/MapPage";
import { HostedViewerPage } from "./features/share/HostedViewerPage";
import { NoteViewerPage } from "./features/share/NoteViewerPage";
import { SnapshotViewerPage } from "./features/share/SnapshotViewerPage";

function RootLayout() {
  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      <nav
        aria-label="Primary"
        className="flex shrink-0 items-center justify-around border-t border-stone-200 bg-stone-50 py-1"
      >
        <Link to="/" className="rounded px-4 py-2 text-sm font-medium [&.active]:bg-stone-200">
          Map
        </Link>
        <Link to="/lists" className="rounded px-4 py-2 text-sm font-medium [&.active]:bg-stone-200">
          Lists
        </Link>
        <Link
          to="/settings"
          className="rounded px-4 py-2 text-sm font-medium [&.active]:bg-stone-200"
        >
          Settings
        </Link>
      </nav>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MapPage,
});

const listsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lists",
  component: ListsPage,
});

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lists/$listId",
  component: ListPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

// Public share viewers (book/src/sharing.md): snapshot links live in the
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

const noteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/n/$slug",
  component: NoteViewerPage,
});

export const routeTree = rootRoute.addChildren([
  mapRoute,
  listsRoute,
  listRoute,
  settingsRoute,
  snapshotRoute,
  hostedRoute,
  noteRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
