import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { SettingsPage } from "./features/backup/SettingsPage";
import { ListPage } from "./features/lists/ListPage";
import { ListsPage } from "./features/lists/ListsPage";
import { MapPage } from "./features/map/MapPage";

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

export const routeTree = rootRoute.addChildren([mapRoute, listsRoute, listRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
