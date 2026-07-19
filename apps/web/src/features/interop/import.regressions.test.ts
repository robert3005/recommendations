/**
 * Phase 3 import regressions found while auditing spec/src/interop.md.
 *
 * These tests intentionally describe the required behavior rather than the
 * current implementation. Keep them focused: each case protects source data,
 * identity, or the every-row-accounted-for/idempotency contract.
 */
import type { ResolvedPoi, SearchResult } from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { type ImportDeps, resolveReviewItem, runImport } from "./importer";
import { parseGeoJson, parseGpx, parseSavedCsv, parseTakeoutZip } from "./parse";

const NOW = "2026-07-18T12:00:00.000Z";
const PLACE_URL = "https://www.google.com/maps/place/Imported+Cafe/data=!4m2!3m1!1s0xabc:0xdef";
const PIN_URL = "https://www.google.com/maps/search/38.71000,-9.15000";

function result(refId = "101"): SearchResult {
  return {
    ref: { type: "node", id: refId },
    name: "Imported Cafe",
    address: "10 Import Road, Lisbon",
    category: "cafe",
    lat: 38.71,
    lng: -9.15,
  };
}

function poi(searchResult: SearchResult): ResolvedPoi {
  return {
    osmRef: searchResult.ref,
    name: searchResult.name,
    category: searchResult.category ?? "place",
    lat: searchResult.lat,
    lng: searchResult.lng,
    ...(searchResult.address ? { address: searchResult.address } : {}),
    identityTags: { name: searchResult.name },
    resolvedAt: NOW,
  };
}

function deps(search: () => Promise<SearchResult[]>): ImportDeps {
  return {
    search: { search },
    resolver: {
      resolveExact: async (ref) => {
        const matched = result(ref.id);
        return { type: "ok", poi: poi({ ...matched, ref }) };
      },
      searchNearby: async () => [],
      discover: async () => ({ pois: [], truncated: false }),
    },
  };
}

function csvFile(rows: string[], name = "Imported list.csv"): { name: string; bytes: Uint8Array } {
  return {
    name,
    bytes: strToU8(["Title,Note,URL,Address", ...rows].join("\n")),
  };
}

describe("Phase 3 import identity regressions", () => {
  it("keeps import origin and imported facts when a row auto-links to OSM", async () => {
    const repo = new DexieRepository(`import-origin-${crypto.randomUUID()}`);
    try {
      await runImport(
        repo,
        csvFile([`"Imported Cafe","Source note","${PLACE_URL}","10 Import Road, Lisbon"`]),
        deps(async () => [result()]),
        NOW,
      );

      const places = await repo.listPlaces();
      expect(places).toHaveLength(1);
      expect(places[0]?.place).toMatchObject({
        origin: "import",
        currentOsmRef: { type: "node", id: "101" },
        manual: {
          name: "Imported Cafe",
          address: "10 Import Road, Lisbon",
        },
        externalRefs: [{ provider: "google-maps", url: PLACE_URL }],
      });
    } finally {
      repo.db.close();
    }
  });

  it("upgrades the existing imported PlaceId when a later re-import gains an OSM match", async () => {
    const repo = new DexieRepository(`import-upgrade-${crypto.randomUUID()}`);
    let geocoderMatches = false;
    const importDeps = deps(async () => (geocoderMatches ? [result()] : []));
    const file = csvFile([`"Imported Cafe",,"${PLACE_URL}","10 Import Road, Lisbon"`]);
    try {
      const first = await runImport(repo, file, importDeps, NOW);
      const review = await repo.db.importItems
        .where("batchId")
        .equals(first.batchId)
        .filter((item) => item.status === "review")
        .first();
      expect(review).toBeDefined();
      if (!review) throw new Error("missing review row");

      await resolveReviewItem(
        repo,
        importDeps,
        review.id,
        { kind: "coords", lat: 38.71, lng: -9.15 },
        NOW,
      );
      const original = (await repo.listPlaces())[0]?.place;
      expect(original).toBeDefined();

      geocoderMatches = true;
      await runImport(repo, file, importDeps, "2026-07-19T09:00:00.000Z");

      const places = await repo.listPlaces();
      expect(places).toHaveLength(1);
      expect(places[0]?.place).toMatchObject({
        id: original?.id,
        origin: "import",
        currentOsmRef: { type: "node", id: "101" },
        manual: { name: "Imported Cafe", lat: 38.71, lng: -9.15 },
      });
    } finally {
      repo.db.close();
    }
  });

  it("merges source URL and note when import dedup finds an existing membership", async () => {
    const repo = new DexieRepository(`import-metadata-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "trip", name: "Trip", createdAt: NOW, updatedAt: NOW });
      const existing = await repo.addToList(
        "trip",
        {
          kind: "manual",
          facts: { name: "Imported Cafe", lat: 38.71, lng: -9.15 },
        },
        NOW,
      );

      const report = await runImport(
        repo,
        csvFile([`"Imported Cafe","Keep this note","${PIN_URL}",`], "Trip.csv"),
        deps(async () => []),
        "2026-07-19T09:00:00.000Z",
      );

      expect(report.duplicates).toBe(1);
      const place = await repo.getPlace(existing.place.id);
      expect
        .soft(place?.externalRefs ?? [])
        .toContainEqual(expect.objectContaining({ provider: "google-maps", url: PIN_URL }));
      expect
        .soft((await repo.listNotesForPlace(existing.place.id)).map((note) => note.body))
        .toContain("Keep this note");
      const duplicateRow = await repo.db.importItems
        .where("batchId")
        .equals(report.batchId)
        .first();
      expect.soft(duplicateRow?.placeId).toBe(existing.place.id);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 parser and accounting regressions", () => {
  it("never cross-references Takeout geometry by title when Google ids do not match", () => {
    const savedPlaces = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.1, 38.7] },
          properties: {
            Title: "Same Name",
            "Google Maps URL": "https://maps.google.com/?cid=1",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-8.6, 41.15] },
          properties: {
            Title: "Same Name",
            "Google Maps URL": "https://maps.google.com/?cid=2",
          },
        },
      ],
    };
    const zip = zipSync({
      "Takeout/Saved/Trip.csv": strToU8(
        'Title,Note,URL,Address\nSame Name,,"https://maps.google.com/?cid=3",Unknown address\n',
      ),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(JSON.stringify(savedPlaces)),
    });

    const parsed = parseTakeoutZip(zip);
    expect(parsed.lists[0]?.items[0]?.coords).toBeUndefined();
  });

  it("ignores unrelated CSV files elsewhere in a whole Takeout archive", () => {
    const zip = zipSync({
      "Takeout/Saved/Trip.csv": strToU8(
        `Title,Note,URL,Address\n"Imported Cafe",,"${PLACE_URL}",Lisbon\n`,
      ),
      "Takeout/YouTube and YouTube Music/history/watch-history.csv": strToU8(
        "Title,URL\nUnrelated video,https://example.test/video\n",
      ),
    });

    const parsed = parseTakeoutZip(zip);
    expect(parsed.lists.map((list) => list.name)).toEqual(["Trip"]);
  });

  it("keeps Saved Places.json-only rows when custom-list CSVs are also present", () => {
    const savedPlaces = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.2, 38.8] },
          properties: {
            Title: "Starred only",
            "Google Maps URL": "https://maps.google.com/?cid=999",
          },
        },
      ],
    };
    const zip = zipSync({
      "Takeout/Saved/Trip.csv": strToU8(
        `Title,Note,URL,Address\n"Imported Cafe",,"${PLACE_URL}",Lisbon\n`,
      ),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(JSON.stringify(savedPlaces)),
    });

    const parsed = parseTakeoutZip(zip);
    expect(parsed.lists.flatMap((list) => list.items).map((item) => item.title)).toContain(
      "Starred only",
    );
  });

  it("accepts [0,0] as literal coordinates in generic GeoJSON", () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { name: "Null Island marker" },
          },
        ],
      }),
      "Generic GeoJSON",
    );

    expect(parsed.items[0]?.coords).toEqual({ lat: 0, lng: 0 });
  });

  it("retains GPX waypoint descriptions as imported notes", () => {
    const parsed = parseGpx(
      `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="38.7" lon="-9.1"><name>Viewpoint</name><desc>Bring water</desc></wpt></gpx>`,
      "Hike",
    );

    expect(parsed.items[0]).toMatchObject({ title: "Viewpoint", note: "Bring water" });
  });

  it("preserves Takeout note text exactly", () => {
    const parsed = parseSavedCsv(
      'Title,Note,URL,Address\nCafe,"  keep leading and trailing space  ",,',
      "Notes",
    );

    expect(parsed.items[0]?.note).toBe("  keep leading and trailing space  ");
  });

  it("persists an explicit skipped row for every unusable source row", async () => {
    const repo = new DexieRepository(`import-skipped-${crypto.randomUUID()}`);
    try {
      const report = await runImport(
        repo,
        csvFile([',"note without a title",,'], "Skipped.csv"),
        deps(async () => []),
        NOW,
      );
      expect(report.skipped).toBe(1);
      const rows = await repo.db.importItems.where("batchId").equals(report.batchId).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("skipped");
    } finally {
      repo.db.close();
    }
  });

  it("does not duplicate an unresolved review item on identical re-import", async () => {
    const repo = new DexieRepository(`import-review-dedup-${crypto.randomUUID()}`);
    const file = csvFile([`"Unknown Place",,"${PLACE_URL}","Unknown address"`]);
    try {
      await runImport(
        repo,
        file,
        deps(async () => []),
        NOW,
      );
      await runImport(
        repo,
        file,
        deps(async () => []),
        "2026-07-19T09:00:00.000Z",
      );

      const reviewRows = await repo.db.importItems
        .filter((item) => item.status === "review")
        .toArray();
      expect(reviewRows).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });

  it("keeps an address-conflicting same-name geocoder result in review", async () => {
    const repo = new DexieRepository(`import-address-${crypto.randomUUID()}`);
    try {
      const wrongAddress = { ...result(), address: "999 Wrong Street, Porto" };
      const report = await runImport(
        repo,
        csvFile([`"Imported Cafe",,,"10 Import Road, Lisbon"`]),
        deps(async () => [wrongAddress]),
        NOW,
      );

      expect(report).toMatchObject({ placed: 0, linked: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
    } finally {
      repo.db.close();
    }
  });

  it("rejects out-of-range coordinates chosen for a review item", async () => {
    const repo = new DexieRepository(`import-review-coords-${crypto.randomUUID()}`);
    try {
      const report = await runImport(
        repo,
        csvFile([`"Unknown Place",,,"Unknown address"`]),
        deps(async () => []),
        NOW,
      );
      const row = await repo.db.importItems.where("batchId").equals(report.batchId).first();
      expect(row?.status).toBe("review");
      if (!row) throw new Error("missing review row");

      await expect(
        resolveReviewItem(
          repo,
          deps(async () => []),
          row.id,
          { kind: "coords", lat: 91, lng: -9.1 },
          NOW,
        ),
      ).rejects.toThrow(/coordinate/i);
      expect(await repo.listPlaces()).toHaveLength(0);
      expect((await repo.db.importItems.get(row.id))?.status).toBe("review");
    } finally {
      repo.db.close();
    }
  });
});
