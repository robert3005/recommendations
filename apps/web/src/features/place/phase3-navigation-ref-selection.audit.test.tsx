import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

const NOW = "2026-07-19T12:00:00.000Z";

describe("Phase 3 navigation external-ref selection", () => {
  it("uses a retained Google Maps URL even when another external ref was stored first", async () => {
    const repo = new DexieRepository(`phase3-nav-ref-${crypto.randomUUID()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const googleUrl = "https://www.google.com/maps/place/Cafe/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";

    try {
      await repo.createList({ id: "list", name: "Imported", createdAt: NOW, updatedAt: NOW });
      const view = await repo.addToList(
        "list",
        {
          kind: "import",
          facts: { name: "Imported café", lat: 38.7139, lng: -9.1394 },
          externalRef: {
            provider: "web",
            url: "https://cafe.example/",
            importedAt: NOW,
          },
        },
        NOW,
      );
      await repo.updatePlace({
        ...view.place,
        externalRefs: [
          ...(view.place.externalRefs ?? []),
          { provider: "google-maps", url: googleUrl, importedAt: NOW },
        ],
      });

      render(
        <QueryClientProvider client={queryClient}>
          <RepoProvider repo={repo}>
            <PlaceDetailsSheet placeId={view.place.id} />
          </RepoProvider>
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId("open-google-maps")).toHaveAttribute("href", googleUrl);
    } finally {
      queryClient.clear();
      repo.db.close();
    }
  });
});
