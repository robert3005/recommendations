/**
 * Follow-up contracts for Phase 3's persisted review queue and portable
 * round-trips. Interchange metadata must survive the slow/review path just as
 * it does immediate placement, and safety encoding must not mutate owned data.
 */
import {
  type List,
  markerAt,
  type Note,
  type Place,
  type PoiResolver,
  type SearchProvider,
} from "@placemarks/domain";
import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportListCsv, exportListGeoJson } from "./export";
import { resolveReviewItem, runImport } from "./importer";
import { parseSavedCsv } from "./parse";

const NOW = "2026-07-19T12:00:00.000Z";

function noMatches(): { search: SearchProvider; resolver: PoiResolver } {
  return {
    search: { search: vi.fn(async () => []) },
    resolver: {
      resolveExact: vi.fn(async () => ({ type: "gone" as const })),
      searchNearby: vi.fn(async () => []),
      discover: vi.fn(async () => ({ pois: [], truncated: false })),
    },
  };
}

function list(id: string): List {
  return { id, name: "Portable list", marker: markerAt(0), createdAt: NOW, updatedAt: NOW };
}

describe("Phase 3 persisted interchange fidelity follow-up", () => {
  it("keeps a GeoJSON website when placement waits in the persisted review queue", async () => {
    const repo = new DexieRepository(`phase3-review-website-${crypto.randomUUID()}`);
    const website = "https://cafe.example/menu";
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      name: "Review trip",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [] },
          properties: { name: "Café awaiting placement", category: "cafe", website },
        },
      ],
    });

    try {
      const report = await runImport(
        repo,
        { name: "review.geojson", bytes: strToU8(geojson) },
        noMatches(),
        NOW,
      );
      const row = await repo.db.importItems.where("batchId").equals(report.batchId).first();
      if (!row) throw new Error("review row was not persisted");

      await resolveReviewItem(
        repo,
        noMatches(),
        row.id,
        { kind: "coords", lat: 38.7139, lng: -9.1394 },
        "2026-07-20T12:00:00.000Z",
      );

      const place = (await repo.listPlaces())[0]?.place;
      expect(place?.manual?.website).toBe(website);
    } finally {
      repo.db.close();
    }
  });

  it("round-trips formula-escaped owned CSV fields without adding apostrophes", () => {
    const sourcePlace: Place = {
      id: "formula-place",
      origin: "manual",
      osmRefHistory: [],
      manual: {
        name: "=SUM(A1:A2)",
        address: "@sensitive-address",
        lat: 38.7,
        lng: -9.1,
      },
      resolutionState: "unlinked",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const sourceNote: Note = {
      id: "formula-note",
      target: { kind: "place", placeId: sourcePlace.id },
      body: "+owned note",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const parsed = parseSavedCsv(
      exportListCsv(list("formula-list"), [{ place: sourcePlace, notes: [sourceNote] }]),
      "Round trip",
    );

    expect(parsed.items[0]).toMatchObject({
      title: sourcePlace.manual?.name,
      note: sourceNote.body,
      address: sourcePlace.manual?.address,
    });
  });

  it("preserves genuine formula-looking apostrophes from an external Takeout CSV", () => {
    const parsed = parseSavedCsv(
      "Title,Note,URL,Address\n'=SUM(A1:A2),'+owned note,,'@address\n",
      "External Takeout",
    );

    expect(parsed.items[0]).toMatchObject({
      title: "'=SUM(A1:A2)",
      note: "'+owned note",
      address: "'@address",
    });
  });

  it("round-trips a history-only OSM anchor and its attribution through GeoJSON", async () => {
    const repo = new DexieRepository(`phase3-history-geojson-${crypto.randomUUID()}`);
    const ref = { type: "node" as const, id: "202" };
    const sourcePlace: Place = {
      id: "history-only-place",
      origin: "import",
      osmRefHistory: [
        {
          ref,
          linkedAt: NOW,
          unlinkedAt: NOW,
          reason: "replaced",
        },
      ],
      manual: { name: "Former OSM café", category: "cafe", lat: 38.72, lng: -9.14 },
      resolutionState: "unlinked",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const source = exportListGeoJson(list("history-source"), [{ place: sourcePlace, notes: [] }]);

    try {
      await runImport(repo, { name: "history.geojson", bytes: strToU8(source) }, noMatches(), NOW);
      const importedList = (await repo.listLists())[0];
      const importedView = (await repo.listPlaces())[0];
      if (!importedList || !importedView) throw new Error("GeoJSON did not materialize");
      const reexported = JSON.parse(
        exportListGeoJson(importedList, [{ ...importedView, notes: [] }]),
      ) as { attribution?: string };

      expect({
        history: importedView.place.osmRefHistory.map((entry) => entry.ref),
        attributed: reexported.attribution?.includes("ODbL") === true,
      }).toEqual({ history: [ref], attributed: true });
    } finally {
      repo.db.close();
    }
  });

  it("marks the superseded import batch done when its review row moves to a re-import", async () => {
    const repo = new DexieRepository(`phase3-old-review-batch-${crypto.randomUUID()}`);
    const file = {
      name: "Unknown.csv",
      bytes: strToU8("Title,Note,URL,Address\nUnknown,,,Nowhere\n"),
    };

    try {
      const first = await runImport(repo, file, noMatches(), NOW);
      await runImport(repo, file, noMatches(), "2026-07-20T12:00:00.000Z");
      const remaining = await repo.db.importItems
        .where("batchId")
        .equals(first.batchId)
        .filter((item) => item.status === "review")
        .count();
      const oldBatch = await repo.db.importBatches.get(first.batchId);

      expect({ remaining, status: oldBatch?.status }).toEqual({ remaining: 0, status: "done" });
    } finally {
      repo.db.close();
    }
  });

  it("closes the old batch when a later re-import resolves its review row", async () => {
    const repo = new DexieRepository(`phase3-resolved-review-batch-${crypto.randomUUID()}`);
    const file = {
      name: "Resolved.csv",
      bytes: strToU8("Title,Note,URL,Address\nCafé,,https://www.openstreetmap.org/node/303,\n"),
    };
    const resolved = {
      osmRef: { type: "node" as const, id: "303" },
      name: "Café",
      category: "cafe",
      lat: 38.7139,
      lng: -9.1394,
      identityTags: { amenity: "cafe", name: "Café" },
      resolvedAt: "2026-07-20T12:00:00.000Z",
    };
    const resolves = {
      search: { search: vi.fn(async () => []) },
      resolver: {
        resolveExact: vi.fn(async () => ({ type: "ok" as const, poi: resolved })),
        searchNearby: vi.fn(async () => []),
        discover: vi.fn(async () => ({ pois: [], truncated: false })),
      },
    };

    try {
      const first = await runImport(repo, file, noMatches(), NOW);
      await runImport(repo, file, resolves, "2026-07-20T12:00:00.000Z");
      const remaining = await repo.db.importItems
        .where("batchId")
        .equals(first.batchId)
        .filter((item) => item.status === "review")
        .count();
      const oldBatch = await repo.db.importBatches.get(first.batchId);

      expect({ remaining, status: oldBatch?.status }).toEqual({ remaining: 0, status: "done" });
    } finally {
      repo.db.close();
    }
  });
});
