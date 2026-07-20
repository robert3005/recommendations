import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getDefaultRepo, RepoProvider } from "./data/RepoContext";
import { router } from "./router";
import "./index.css";

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
  // Durable publication outbox: interrupted jobs from earlier sessions retry
  // on launch (spec/src/sharing.md §Local publication record) — after the dev
  // mock layer is ready, so requests never race past it.
  void import("./features/publish/publisher").then(({ createSharePublisher }) =>
    createSharePublisher(getDefaultRepo())
      .drainOutbox()
      .catch(() => {
        // Offline is a designed state; the outbox retries next launch/enqueue.
      }),
  );
  // Background multi-device sync (spec/src/storage-sync.md): the transport
  // drains the mutation outbox on launch and on a slow heartbeat when a sync
  // scope is signed in. Offline attempts are silent; the outbox is durable.
  void import("./features/sync/engine").then(({ syncNow }) => {
    const run = () =>
      syncNow(getDefaultRepo()).catch(() => {
        // Offline is a designed state; mutations stay queued.
      });
    void run();
    setInterval(run, 60_000);
  });
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RepoProvider repo={getDefaultRepo()}>
          <RouterProvider router={router} />
        </RepoProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
