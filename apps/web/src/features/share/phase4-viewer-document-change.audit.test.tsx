import type { SharedGuide, SharedPlaceEvidence } from "@placemarks/schemas";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { useProjectionStore } from "../../state/projection";
import { SharedGuideView } from "./SharedGuideView";

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: vi.fn(async (ref: { id: string }) => ({
      type: "ok",
      poi: {
        osmRef: { type: "node", id: ref.id },
        name: ref.id === "101" ? "Copied Document A" : "Copied Document B",
        category: "viewpoint",
        lat: ref.id === "101" ? 10 : 20,
        lng: ref.id === "101" ? 11 : 21,
        identityTags: {},
        resolvedAt: "2026-07-20T12:00:00.000Z",
      },
    })),
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

function document(refId: string, title: string): SharedGuide {
  const evidence: SharedPlaceEvidence = {
    osmRef: { type: "node", id: refId },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: `Copied ${title}`,
    category: "viewpoint",
    lat: refId === "101" ? 10.001 : 20.001,
    lng: refId === "101" ? 11.001 : 21.001,
    observedAt: "2025-07-20T12:00:00.000Z",
  };
  return {
    v: 1,
    kind: "post",
    title,
    blocks: [
      {
        id: "same-block-id",
        type: "place",
        place: {
          kind: "osm",
          currentOsmRef: { type: "node", id: refId },
          firstSeen: evidence,
          lastVerified: evidence,
        },
      },
    ],
    contentHash: `hash-${refId}`,
  };
}

function currentPin() {
  const projection = useProjectionStore.getState().projection;
  if (projection.kind !== "shared") throw new Error("missing shared projection");
  return projection.pins[0];
}

beforeEach(() => {
  useProjectionStore.setState({ projection: { kind: "all" }, sharedSelectHandler: null });
});

describe("public viewer document changes", () => {
  it("re-resolves a replacement document and clears the prior selection/live coordinates", async () => {
    const repo = new DexieRepository(`viewer-document-change-${crypto.randomUUID()}`);
    const first = document("101", "Document A");
    const second = document("202", "Document B");
    try {
      const view = render(
        <RepoProvider repo={repo}>
          <SharedGuideView guide={first} mode="hosted" />
        </RepoProvider>,
      );

      await waitFor(() =>
        expect(currentPin()).toMatchObject({ name: "Copied Document A", lat: 10, lng: 11 }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Copied Document A" }));
      await waitFor(() => expect(currentPin()?.selected).toBe(true));

      view.rerender(
        <RepoProvider repo={repo}>
          <SharedGuideView guide={second} mode="hosted" />
        </RepoProvider>,
      );

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Copied Document B" })).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(currentPin()).toMatchObject({ name: "Copied Document B", lat: 20, lng: 21 }),
      );
      expect(currentPin()?.selected).toBeUndefined();
    } finally {
      repo.db.close();
    }
  });
});
