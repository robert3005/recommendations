import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { getDefaultRepo, RepoProvider } from "./data/RepoContext";
import { router } from "./router";
import "./index.css";

// Sync renders nothing and its engine (crypto, the wire schemas, zod) is not
// needed to paint the notebook: it loads right after launch, off the critical
// path (performance budget, spec/src/roadmap.md).
const SyncRunner = lazy(() =>
  import("./features/sync/SyncRunner").then((m) => ({ default: m.SyncRunner })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

async function prepare(): Promise<void> {
  // Dev-only request mocking for working without hitting public OSM services.
  if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_MSW === "true") {
    try {
      const { worker } = await import("./mocks/browser");
      await worker.start({ onUnhandledRequest: "bypass" });
    } catch (err) {
      // A dev nicety must never block the shell (e.g. service workers disabled).
      console.warn("MSW failed to start; continuing without request mocking", err);
    }
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root");

void prepare().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RepoProvider repo={getDefaultRepo()}>
          {/* Sync runs beside the router, not inside it: it is the library's
              business, whatever page is showing (spec/src/sync.md §The cycle). */}
          <Suspense fallback={null}>
            <SyncRunner />
          </Suspense>
          <RouterProvider router={router} />
        </RepoProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
