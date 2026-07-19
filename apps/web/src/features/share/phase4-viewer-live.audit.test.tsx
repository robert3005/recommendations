/** Public-viewer freshness checks from book/src/sharing.md. */
import type { SharedGuide } from "@placemarks/schemas";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { SharedGuideView } from "./SharedGuideView";

const phase4 = vi.hoisted(() => ({ resolveExact: vi.fn() }));

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: phase4.resolveExact,
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

vi.mock("../../map/MapView", () => ({
  MapView: () => <div data-testid="shared-map" />,
}));

const OBSERVED = "2020-01-02T03:04:05.000Z";

function guide(): SharedGuide {
  const evidence = {
    osmRef: { type: "node" as const, id: "101" },
    source: "OpenStreetMap" as const,
    license: "ODbL-1.0" as const,
    attribution: "© OpenStreetMap contributors" as const,
    name: "Copied old café",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    address: "Copied old address",
    observedAt: OBSERVED,
  };
  return {
    v: 1,
    title: "Lisbon",
    blocks: [
      {
        id: "b1",
        type: "place",
        place: {
          kind: "osm",
          currentOsmRef: { type: "node", id: "101" },
          firstSeen: evidence,
          lastVerified: evidence,
        },
      },
    ],
    contentHash: "fixture",
  };
}

afterEach(() => {
  phase4.resolveExact.mockReset();
});

describe("Phase 4 public viewer freshness", () => {
  it("labels copied evidence with its observation time while live resolution is pending", () => {
    phase4.resolveExact.mockImplementation(() => new Promise(() => {}));
    const repo = new DexieRepository(`phase4-viewer-pending-${crypto.randomUUID()}`);
    const view = render(
      <RepoProvider repo={repo}>
        <SharedGuideView guide={guide()} mode="snapshot" />
      </RepoProvider>,
    );

    try {
      expect(screen.getByText("Copied old café")).toBeInTheDocument();
      expect(screen.getByText(/showing saved facts.*observed 2020-01-02/i)).toBeInTheDocument();
    } finally {
      view.unmount();
      repo.db.close();
    }
  });
});
