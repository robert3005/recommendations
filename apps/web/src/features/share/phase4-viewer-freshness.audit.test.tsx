/** The public viewer must replace copied fallback fields after an exact live resolve. */
import type { SharedGuide, SharedPlaceEvidence } from "@placemarks/schemas";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { SharedGuideView } from "./SharedGuideView";

const viewerMocks = vi.hoisted(() => ({ resolveExact: vi.fn() }));

vi.mock("../../map/MapView", () => ({ MapView: () => null }));
vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: viewerMocks.resolveExact,
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

const NOW = "2026-07-19T14:00:00.000Z";

function copiedEvidence(): SharedPlaceEvidence {
  return {
    osmRef: { type: "node", id: "101" },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Old copied name",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    address: "Old copied address",
    website: "https://old.example",
    observedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("Phase 4 viewer freshness", () => {
  it("shows the successfully resolved current OSM facts instead of unlabeled copied facts", async () => {
    viewerMocks.resolveExact.mockResolvedValue({
      type: "ok",
      poi: {
        osmRef: { type: "node", id: "101" },
        name: "Current live name",
        category: "restaurant",
        lat: 38.714,
        lng: -9.139,
        address: "Current live address",
        website: "https://current.example",
        identityTags: { amenity: "restaurant", name: "Current live name" },
        resolvedAt: NOW,
      },
    });
    const copied = copiedEvidence();
    const guide: SharedGuide = {
      v: 1,
      kind: "list",
      title: "Shared Lisbon",
      blocks: [
        {
          id: "b1",
          type: "place",
          place: {
            kind: "osm",
            currentOsmRef: { type: "node", id: "101" },
            firstSeen: copied,
            lastVerified: copied,
          },
        },
      ],
      contentHash: "fixture",
    };
    const repo = new DexieRepository(`phase4-live-fields-${crypto.randomUUID()}`);

    try {
      render(
        <RepoProvider repo={repo}>
          <SharedGuideView guide={guide} mode="snapshot" />
        </RepoProvider>,
      );

      await waitFor(() => expect(viewerMocks.resolveExact).toHaveBeenCalledOnce());
      expect(await screen.findByText("Current live name")).toBeInTheDocument();
      expect(screen.getByText("Current live address")).toBeInTheDocument();
      expect(screen.queryByText("Old copied name")).not.toBeInTheDocument();
      expect(screen.queryByText("Old copied address")).not.toBeInTheDocument();
    } finally {
      repo.db.close();
    }
  });
});
