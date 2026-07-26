/**
 * A successful live OSM refresh drives both sides of the synchronized reader
 * — on the singleton canvas projection (spec/src/sharing.md §Public viewer):
 * the projected pin moves to the RESOLVED coordinates, and selecting the
 * article entry recentres there, never at stale copied coordinates.
 */
import type { SharedGuide, SharedPlaceEvidence } from "@placemarks/schemas";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { useProjectionStore } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { SharedGuideView } from "./SharedGuideView";

const LIVE = { lat: 38.735, lng: -9.115 };

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: vi.fn(async () => ({
      type: "ok",
      poi: {
        osmRef: { type: "node", id: "101" },
        name: "Café Central",
        category: "cafe",
        ...LIVE,
        identityTags: { wikidata: "Q123" },
        resolvedAt: "2026-07-19T13:00:00.000Z",
      },
    })),
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

const copied: SharedPlaceEvidence = {
  osmRef: { type: "node", id: "101" },
  source: "OpenStreetMap",
  license: "ODbL-1.0",
  attribution: "© OpenStreetMap contributors",
  name: "Café Central",
  category: "cafe",
  lat: 38.7139,
  lng: -9.1394,
  stableIds: { wikidata: "Q123" },
  observedAt: "2025-07-19T13:00:00.000Z",
};

const guide: SharedGuide = {
  v: 1,
  kind: "list",
  title: "Live coordinates",
  blocks: [
    {
      id: "cafe-block",
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

function sharedPins(): { key: string; lat: number; lng: number; selected?: boolean }[] {
  const projection = useProjectionStore.getState().projection;
  return projection.kind === "shared" ? projection.pins : [];
}

beforeEach(() => {
  useProjectionStore.setState({ projection: { kind: "all" }, sharedSelectHandler: null });
  useUiStore.setState({ selection: null, flyTo: null });
});

describe("Phase 4 live-coordinate map/article synchronization", () => {
  it("recentres and selects at the resolved coordinates rather than stale copied coordinates", async () => {
    const repo = new DexieRepository(`phase4-live-coordinate-sync-${crypto.randomUUID()}`);
    try {
      render(
        <RepoProvider repo={repo}>
          <SharedGuideView guide={guide} mode="snapshot" />
        </RepoProvider>,
      );

      await waitFor(() => expect(sharedPins()[0]).toMatchObject({ lat: LIVE.lat, lng: LIVE.lng }));
      await userEvent.click(screen.getByRole("button", { name: "Café Central" }));

      await waitFor(() => expect(useUiStore.getState().flyTo).toMatchObject(LIVE));
      expect(sharedPins().find((pin) => pin.key === "cafe-block")).toMatchObject({
        ...LIVE,
        selected: true,
      });
    } finally {
      repo.db.close();
    }
  });
});
