/** Shared-guide import keeps the complete recovery envelope through offline review. */
import { markerAt, type PoiResolver, type ResolvedPoi } from "@placemarks/domain";
import type { SharedGuide, SharedPlaceEvidence } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { saveSharedGuide } from "./saveSharedGuide";

const NOW = "2026-07-19T12:00:00.000Z";

const unavailable: PoiResolver = {
  resolveExact: async () => ({ type: "error" }),
  searchNearby: async () => [],
  discover: async () => ({ pois: [], truncated: false }),
};

function evidence(
  ref: SharedPlaceEvidence["osmRef"],
  overrides: Partial<SharedPlaceEvidence>,
): SharedPlaceEvidence {
  return {
    osmRef: ref,
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Shared cafe",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    observedAt: NOW,
    ...overrides,
  };
}

describe("Phase 4 pending preview fidelity", () => {
  it("retains both evidence epochs and every selected note while resolution is unavailable", async () => {
    const repo = new DexieRepository(`phase4-pending-fidelity-${crypto.randomUUID()}`);
    const ref = { type: "node" as const, id: "101" };
    const firstSeen = evidence(ref, {
      name: "FIRST-SEEN-NAME",
      lat: 38.71,
      lng: -9.14,
      website: "https://first-evidence.example/path",
      stableIds: { wikidata: "Q-FIRST-EVIDENCE" },
      observedAt: "2021-01-02T03:04:05.000Z",
    });
    const lastVerified = evidence(ref, {
      name: "LAST-VERIFIED-NAME",
      phone: "+351-LAST-EVIDENCE-PHONE",
      stableIds: { "brand:wikidata": "Q-LAST-EVIDENCE" },
      observedAt: "2026-01-02T03:04:05.000Z",
    });
    const guide: SharedGuide = {
      v: 1,
      title: "Pending fidelity",
      blocks: [
        {
          id: "place-1",
          type: "place",
          place: { kind: "osm", currentOsmRef: ref, firstSeen, lastVerified },
          notes: [
            { title: "FIRST-NOTE-TITLE", body: "FIRST-NOTE-BODY" },
            { title: "SECOND-NOTE-TITLE", body: "SECOND-NOTE-BODY" },
          ],
        },
      ],
      contentHash: "fixture",
    };

    try {
      expect(await saveSharedGuide(repo, unavailable, guide, NOW)).toMatchObject({ pending: 1 });
      const pending = await repo.db.importItems.filter((item) => item.status === "review").first();
      const persisted = JSON.stringify(pending);

      for (const value of [
        "FIRST-SEEN-NAME",
        "https://first-evidence.example/path",
        "Q-FIRST-EVIDENCE",
        "2021-01-02T03:04:05.000Z",
        "LAST-VERIFIED-NAME",
        "+351-LAST-EVIDENCE-PHONE",
        "Q-LAST-EVIDENCE",
        "2026-01-02T03:04:05.000Z",
        "FIRST-NOTE-TITLE",
        "FIRST-NOTE-BODY",
        "SECOND-NOTE-TITLE",
        "SECOND-NOTE-BODY",
      ]) {
        expect(persisted).toContain(value);
      }
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 4 local evidence deduplication", () => {
  it("reuses one unique local evidence match even when the shared ref and provider are unavailable", async () => {
    const repo = new DexieRepository(`phase4-local-evidence-${crypto.randomUUID()}`);
    const localPoi: ResolvedPoi = {
      osmRef: { type: "way", id: "202" },
      osmVersion: 12,
      name: "Recovered cafe",
      category: "cafe",
      lat: 38.7139,
      lng: -9.1394,
      website: "https://recovered.example",
      identityTags: { wikidata: "Q-UNIQUE-PLACE" },
      resolvedAt: NOW,
    };
    const oldRef = { type: "node" as const, id: "101" };
    const copied = evidence(oldRef, {
      name: localPoi.name,
      website: localPoi.website,
      stableIds: { wikidata: "Q-UNIQUE-PLACE" },
    });
    const guide: SharedGuide = {
      v: 1,
      title: "Evidence match",
      blocks: [
        {
          id: "place-1",
          type: "place",
          place: {
            kind: "osm",
            currentOsmRef: oldRef,
            firstSeen: copied,
            lastVerified: copied,
          },
        },
      ],
      contentHash: "fixture",
    };

    try {
      await repo.createList({
        id: "existing",
        name: "Existing",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const local = await repo.addToList("existing", { kind: "poi", poi: localPoi }, NOW);

      const result = await saveSharedGuide(repo, unavailable, guide, NOW);

      expect(result).toMatchObject({ added: 1, pending: 0 });
      expect(await repo.listPlaces()).toHaveLength(1);
      expect(await repo.listIdsForPlace(local.place.id)).toContain(result.listId);
    } finally {
      repo.db.close();
    }
  });
});
