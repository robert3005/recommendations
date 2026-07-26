/** Place deduplication must not discard the guide prose attached to that place. */
import { markerAt, type PoiResolver } from "@placemarks/domain";
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { saveSharedGuide } from "./saveSharedGuide";

const NOW = "2026-07-19T13:00:00.000Z";
const resolver: PoiResolver = {
  resolveExact: async () => ({ type: "error" }),
  searchNearby: async () => [],
  discover: async () => ({ pois: [], truncated: false }),
};

describe("Phase 4 guide-import note fidelity after deduplication", () => {
  it("imports selected notes when the place membership already exists", async () => {
    const repo = new DexieRepository(`phase4-dedup-note-fidelity-${crypto.randomUUID()}`);
    const guide: SharedGuide = {
      v: 1,
      kind: "list",
      title: "Existing guide",
      blocks: [
        {
          id: "viewpoint-block",
          type: "place",
          place: { kind: "manual", name: "Viewpoint", lat: 38.7, lng: -9.1 },
          notes: [{ title: "Sunset", body: "Arrive before golden hour." }],
        },
      ],
      contentHash: "fixture",
    };

    try {
      await repo.createList({
        id: "list-1",
        name: guide.title,
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const existing = await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Viewpoint", lat: 38.7, lng: -9.1 } },
        NOW,
      );

      const result = await saveSharedGuide(repo, resolver, guide, NOW);

      expect(result).toMatchObject({ duplicates: 1, added: 0 });
      expect(await repo.listNotesForPlace(existing.place.id)).toEqual([
        expect.objectContaining({ title: "Sunset", body: "Arrive before golden hour." }),
      ]);
    } finally {
      repo.db.close();
    }
  });
});
