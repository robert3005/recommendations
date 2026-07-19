/**
 * ODbL presentation contract from spec/src/data-sources.md: attribution is a
 * link wherever public OSM-derived facts are presented, not inert text.
 */
import type { SharedGuide, SharedNote, SharedPlaceAnchor } from "@placemarks/schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { NoteViewerPage } from "./NoteViewerPage";
import { SharedGuideView } from "./SharedGuideView";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: "osm-note" }),
}));

vi.mock("../../map/MapView", () => ({ MapView: () => <div data-testid="shared-map" /> }));
vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: vi.fn(() => new Promise(() => {})),
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

const evidence = {
  osmRef: { type: "node" as const, id: "101" },
  source: "OpenStreetMap" as const,
  license: "ODbL-1.0" as const,
  attribution: "© OpenStreetMap contributors" as const,
  name: "Café",
  category: "cafe",
  lat: 51.5,
  lng: -0.12,
  observedAt: "2026-07-19T12:00:00.000Z",
};

const anchor: SharedPlaceAnchor = {
  kind: "osm",
  currentOsmRef: evidence.osmRef,
  firstSeen: evidence,
  lastVerified: evidence,
};

const guide: SharedGuide = {
  v: 1,
  title: "OSM guide",
  blocks: [
    {
      id: "place-1",
      type: "place",
      place: anchor,
    },
  ],
  contentHash: "linked-attribution-fixture",
};

describe("linked public OSM attribution", () => {
  it("links public-guide attribution to the OpenStreetMap copyright page", () => {
    const repo = new DexieRepository(`phase01-attribution-${crypto.randomUUID()}`);
    const view = render(
      <RepoProvider repo={repo}>
        <SharedGuideView guide={guide} mode="hosted" />
      </RepoProvider>,
    );

    try {
      expect(screen.getByText("Café")).toBeInTheDocument();
      const attribution = screen.getByRole("link", {
        name: /© OpenStreetMap contributors/i,
      });
      expect(attribution).toHaveAttribute(
        "href",
        expect.stringMatching(/^https:\/\/(www\.)?openstreetmap\.org\/copyright/),
      );
    } finally {
      view.unmount();
      repo.db.close();
    }
  });

  it("links standalone-note OSM attribution to the copyright page", async () => {
    const note: SharedNote = {
      v: 1,
      slug: "osm-note",
      title: "A shared note",
      context: { kind: "place", place: anchor },
      body: "Public prose",
      media: [],
      contentHash: "note-attribution-fixture",
      publishedAt: "2026-07-19T12:00:00.000Z",
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(note)),
    );

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <NoteViewerPage />
        </QueryClientProvider>,
      );

      expect(await screen.findByText("Café")).toBeInTheDocument();
      const attribution = screen.getByRole("link", {
        name: /© OpenStreetMap contributors/i,
      });
      expect(attribution).toHaveAttribute(
        "href",
        expect.stringMatching(/^https:\/\/(www\.)?openstreetmap\.org\/copyright/),
      );
    } finally {
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
});
