import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

const NOW = "2026-07-18T12:00:00.000Z";

describe("import licensing boundary", () => {
  it("does not prefill the OSM editor from imported Google coordinates", async () => {
    const repo = new DexieRepository(`import-osm-valve-${crypto.randomUUID()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    try {
      await repo.createList({ id: "l1", name: "Takeout", createdAt: NOW, updatedAt: NOW });
      const imported = await repo.addToList(
        "l1",
        {
          kind: "import",
          facts: { name: "Imported café", lat: 38.7139, lng: -9.1394 },
          externalRef: {
            provider: "google-maps",
            url: "https://www.google.com/maps/place/?q=place_id:example",
            importedAt: NOW,
          },
        },
        NOW,
      );

      render(
        <QueryClientProvider client={queryClient}>
          <RepoProvider repo={repo}>
            <PlaceDetailsSheet placeId={imported.place.id} />
          </RepoProvider>
        </QueryClientProvider>,
      );

      const user = userEvent.setup();
      await user.click(await screen.findByTestId("link-to-osm"));

      expect(
        screen.queryByRole("link", { name: "Add it on OpenStreetMap" }),
      ).not.toBeInTheDocument();
    } finally {
      queryClient.clear();
      repo.db.close();
    }
  });
});
