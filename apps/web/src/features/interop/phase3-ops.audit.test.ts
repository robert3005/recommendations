import type { PoiResolver, SearchProvider, SearchResult } from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { runImport } from "./importer";
import { parseTakeoutZip } from "./parse";

const NOW = "2026-07-19T02:00:00.000Z";

function unresolvedDeps(results: SearchResult[] = []): {
  search: SearchProvider;
  resolver: PoiResolver;
} {
  return {
    search: { search: vi.fn(async () => results) },
    resolver: {
      resolveExact: vi.fn(async () => ({ type: "error" as const })),
      searchNearby: vi.fn(async () => []),
      discover: vi.fn(async () => ({ pois: [], truncated: false })),
    },
  };
}

describe("Phase 3 operational accounting audit", () => {
  it("accounts for unusable Saved Places features even when CSV lists are present", () => {
    const placeUrl = "https://www.google.com/maps/place/One/data=!4m2!3m1!1s0x1:0x2";
    const savedPlaces = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.1, 38.7] },
          properties: { Title: "One", "Google Maps URL": placeUrl },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.2, 38.8] },
          properties: {},
        },
      ],
    };
    const archive = zipSync({
      "Takeout/Saved/Trip.csv": strToU8(`Title,Note,URL,Address\nOne,,${placeUrl},\n`),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(JSON.stringify(savedPlaces)),
    });

    const parsed = parseTakeoutZip(archive);
    const sourceRows = parsed.lists.flatMap((list) => [...list.items, ...list.unusable]);
    expect(sourceRows).toHaveLength(2);
    expect(parsed.lists.flatMap((list) => list.unusable)).toHaveLength(1);
  });

  it("does not leave a re-import batch reviewing when it owns no review item", async () => {
    const repo = new DexieRepository(`phase3-review-batch-${crypto.randomUUID()}`);
    const file = {
      name: "Unknown.csv",
      bytes: strToU8("Title,Note,URL,Address\nUnknown,,,Nowhere\n"),
    };

    try {
      await runImport(repo, file, unresolvedDeps(), NOW);
      const again = await runImport(repo, file, unresolvedDeps(), "2026-07-19T03:00:00.000Z");
      const ownedReviewItems = await repo.db.importItems
        .where("batchId")
        .equals(again.batchId)
        .filter((item) => item.status === "review")
        .count();
      const batch = await repo.db.importBatches.get(again.batchId);

      expect(again.review).toBe(ownedReviewItems);
      expect(batch?.status).toBe(ownedReviewItems > 0 ? "reviewing" : "done");
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 geocoder licensing audit", () => {
  it("keeps a geocoder candidate in review when exact OSM resolution fails", async () => {
    const candidate: SearchResult = {
      ref: { type: "node", id: "101" },
      name: "Imported café",
      address: "10 Example Road, Lisbon",
      category: "cafe",
      lat: 38.71,
      lng: -9.15,
    };
    const repo = new DexieRepository(`phase3-osm-coords-${crypto.randomUUID()}`);

    try {
      const report = await runImport(
        repo,
        {
          name: "Imported.csv",
          bytes: strToU8('Title,Note,URL,Address\n"Imported café",,,"10 Example Road, Lisbon"\n'),
        },
        unresolvedDeps([candidate]),
        NOW,
      );
      expect(report).toMatchObject({ placed: 0, linked: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
      expect(
        await repo.db.importItems.where("batchId").equals(report.batchId).first(),
      ).toMatchObject({ status: "review", candidates: [candidate] });
    } finally {
      repo.db.close();
    }
  });
});
