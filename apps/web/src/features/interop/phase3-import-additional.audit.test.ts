/**
 * Additional Phase 3 import checks derived from the current authoritative book.
 *
 * These focus on identity ordering and failure/accounting paths not covered by
 * the existing Phase 3 suites. In particular, an OSM ref must outrank fuzzy
 * name/proximity matching, and provider unavailability must never make a source
 * row disappear from the persisted import workflow.
 */
import {
  linkPlaceToOsm,
  type PoiResolver,
  type ResolvedPoi,
  type SearchProvider,
  type SearchResult,
} from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { resolveReviewItem, runImport } from "./importer";
import { parseImportFile, parseTakeoutZip } from "./parse";

const NOW = "2026-07-19T12:00:00.000Z";

function poi(id: string, name: string, overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name,
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { amenity: "cafe", name },
    resolvedAt: NOW,
    ...overrides,
  };
}

function providers(
  options: { search?: SearchResult[]; resolveExact?: PoiResolver["resolveExact"] } = {},
): { search: SearchProvider; resolver: PoiResolver } {
  return {
    search: { search: vi.fn(async () => options.search ?? []) },
    resolver: {
      resolveExact: options.resolveExact ?? vi.fn(async () => ({ type: "error" as const })),
      searchNearby: vi.fn(async () => []),
      discover: vi.fn(async () => ({ pois: [], truncated: false })),
    },
  };
}

function geoJsonFile(
  name: string,
  properties: Record<string, unknown>,
  coords: [number, number] = [-9.1394, 38.7139],
): { name: string; bytes: Uint8Array } {
  return {
    name,
    bytes: strToU8(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: coords },
            properties,
          },
        ],
      }),
    ),
  };
}

describe("Phase 3 Takeout identity audit", () => {
  it("does not cross-reference Takeout geometry by title when neither row has a Google id", () => {
    const archive = zipSync({
      "Takeout/Saved/Trip.csv": strToU8(
        'Title,Note,URL,Address\n"Common name",,,"A different address"\n',
      ),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
              properties: { Title: "Common name" },
            },
          ],
        }),
      ),
    });

    const parsed = parseTakeoutZip(archive);
    const csvItem = parsed.lists.find((list) => list.name === "Trip")?.items[0];
    const geometryItem = parsed.lists.find((list) => list.name === "Saved places")?.items[0];

    expect(csvItem?.coords).toBeUndefined();
    expect(geometryItem?.coords).toEqual({ lat: 38.7139, lng: -9.1394 });
  });

  it("rejects a ZIP with no recognized Takeout entries", async () => {
    await expect(
      parseImportFile({
        name: "not-takeout.zip",
        bytes: zipSync({ "readme.txt": strToU8("This is not a Takeout archive") }),
      }),
    ).rejects.toThrow(/takeout|recognized|supported/i);
  });
});

describe("Phase 3 parser failure audit", () => {
  it.each([
    { name: "broken.kml", body: "<kml><Document><Placemark>" },
    { name: "broken.gpx", body: '<gpx><wpt lat="38.7" lon="-9.1">' },
  ])("rejects malformed XML imports instead of reporting an empty success: $name", async (file) => {
    await expect(parseImportFile({ name: file.name, bytes: strToU8(file.body) })).rejects.toThrow(
      /xml|malformed|invalid|parse/i,
    );
  });

  it("turns nested KML folders into separate source lists without duplicating placemarks", async () => {
    const parsed = await parseImportFile({
      name: "nested.kml",
      bytes: strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Folder><name>Parent</name>
    <Placemark><name>Parent place</name><Point><coordinates>-9.2,38.8</coordinates></Point></Placemark>
    <Folder><name>Child</name>
      <Placemark><name>Child place</name><Point><coordinates>-9.1,38.7</coordinates></Point></Placemark>
    </Folder>
  </Folder>
</Document></kml>`),
    });

    expect(
      Object.fromEntries(
        parsed.lists.map((list) => [list.name, list.items.map((item) => item.title)]),
      ),
    ).toEqual({ Parent: ["Parent place"], Child: ["Child place"] });
    expect(parsed.lists.flatMap((list) => list.items)).toHaveLength(2);
  });
});

describe("Phase 3 provider-failure persistence audit", () => {
  it("clears an earlier pending review when re-import later resolves the same anchored item", async () => {
    const repo = new DexieRepository(`phase3-review-recovered-${crypto.randomUUID()}`);
    const resolvedPoi = poi("700", "Recovered café");
    let available = false;
    const deps = providers({
      resolveExact: vi.fn(async () =>
        available ? { type: "ok" as const, poi: resolvedPoi } : { type: "error" as const },
      ),
    });
    const file = geoJsonFile("recovered.geojson", {
      name: "Recovered café",
      category: "cafe",
      osmRef: "node/700",
    });

    try {
      const first = await runImport(repo, file, deps, NOW);
      expect(first).toMatchObject({ placed: 0, review: 1 });

      available = true;
      const second = await runImport(repo, file, deps, "2026-07-20T12:00:00.000Z");

      expect(second).toMatchObject({ placed: 1, linked: 1, review: 0 });
      expect(await repo.listPlaces()).toHaveLength(1);
      expect(await repo.db.importItems.filter((item) => item.status === "review").count()).toBe(0);
    } finally {
      repo.db.close();
    }
  });

  it("keeps distinct unresolved OSM anchors as distinct review items", async () => {
    const repo = new DexieRepository(`phase3-review-anchor-identity-${crypto.randomUUID()}`);
    const deps = providers();
    const bytes = strToU8(
      JSON.stringify({
        type: "FeatureCollection",
        features: ["701", "702"].map((id, index) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.1394 + index * 0.001, 38.7139] },
          properties: { name: "Common name", category: "cafe", osmRef: `node/${id}` },
        })),
      }),
    );

    try {
      const report = await runImport(repo, { name: "distinct-anchors.geojson", bytes }, deps, NOW);
      const rows = await repo.db.importItems.where("batchId").equals(report.batchId).toArray();
      const persisted = rows.map((row) => JSON.stringify(row));

      expect(report).toMatchObject({ placed: 0, review: 2 });
      expect(rows).toHaveLength(2);
      expect(persisted.some((row) => row.includes("701"))).toBe(true);
      expect(persisted.some((row) => row.includes("702"))).toBe(true);
    } finally {
      repo.db.close();
    }
  });

  it("keeps an exact-anchored row in review when exact resolution rejects", async () => {
    const repo = new DexieRepository(`phase3-exact-reject-${crypto.randomUUID()}`);
    const ref = { type: "node" as const, id: "101" };
    const deps = providers({
      resolveExact: vi.fn(async () => {
        throw new Error("resolver offline");
      }),
    });

    try {
      const report = await runImport(
        repo,
        geoJsonFile("anchored.geojson", {
          name: "Café Central",
          category: "cafe",
          osmRef: `${ref.type}/${ref.id}`,
        }),
        deps,
        NOW,
      );
      const row = await repo.db.importItems.where("batchId").equals(report.batchId).first();

      expect(report).toMatchObject({ placed: 0, linked: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
      expect(row).toMatchObject({
        status: "review",
        coords: { lat: 38.7139, lng: -9.1394 },
        raw: { title: "Café Central" },
      });
      const persisted = JSON.stringify(row);
      expect(persisted).toContain(ref.type);
      expect(persisted).toContain(ref.id);
    } finally {
      repo.db.close();
    }
  });

  it("keeps a candidate review item retryable when exact resolution rejects", async () => {
    const repo = new DexieRepository(`phase3-review-reject-${crypto.randomUUID()}`);
    const candidates: SearchResult[] = [
      {
        ref: { type: "node", id: "201" },
        name: "Common Café",
        address: "10 Main Street, Lisbon",
        category: "cafe",
        lat: 38.71,
        lng: -9.14,
      },
      {
        ref: { type: "way", id: "202" },
        name: "Common Café",
        address: "10 Main Street, Lisbon",
        category: "cafe",
        lat: 38.711,
        lng: -9.141,
      },
    ];
    const deps = providers({
      search: candidates,
      resolveExact: vi.fn(async () => {
        throw new Error("resolver offline");
      }),
    });

    try {
      const report = await runImport(
        repo,
        {
          name: "ambiguous.csv",
          bytes: strToU8('Title,Note,URL,Address\n"Common Café",,,"10 Main Street, Lisbon"\n'),
        },
        deps,
        NOW,
      );
      const row = await repo.db.importItems.where("batchId").equals(report.batchId).first();
      if (!row) throw new Error("missing persisted review row");
      const firstCandidate = candidates[0];
      if (!firstCandidate) throw new Error("missing candidate fixture");

      await expect(
        resolveReviewItem(repo, deps, row.id, { kind: "candidate", ref: firstCandidate.ref }, NOW),
      ).resolves.toBeUndefined();
      expect(await repo.db.importItems.get(row.id)).toMatchObject({ status: "review" });
      expect(await repo.db.importBatches.get(row.batchId)).toMatchObject({ status: "reviewing" });
    } finally {
      repo.db.close();
    }
  });

  it("retains full GeoJSON metadata while an item waits for manual review", async () => {
    const repo = new DexieRepository(`phase3-review-fidelity-${crypto.randomUUID()}`);
    const googleUrl = "https://www.google.com/maps/place/Cafe/data=!4m2!3m1!1s0xaaa:0xbbb";
    const webUrl = "https://cafe.example/menu";
    const file = {
      name: "review.geojson",
      bytes: strToU8(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [] },
              properties: {
                name: "Café awaiting placement",
                category: "cafe",
                phone: "+351 210 000 000",
                openingHours: "Mo-Fr 08:00-18:00",
                tags: ["Coffee", "Quiet"],
                note: "Window table",
                externalUrls: [googleUrl, webUrl],
              },
            },
          ],
        }),
      ),
    };

    try {
      const report = await runImport(repo, file, providers(), NOW);
      const row = await repo.db.importItems.where("batchId").equals(report.batchId).first();
      if (!row) throw new Error("missing persisted review row");
      expect(report).toMatchObject({ placed: 0, review: 1 });

      await resolveReviewItem(
        repo,
        providers(),
        row.id,
        { kind: "coords", lat: 38.7139, lng: -9.1394 },
        "2026-07-20T12:00:00.000Z",
      );

      const view = (await repo.listPlaces())[0];
      expect(view?.place.manual).toMatchObject({
        name: "Café awaiting placement",
        category: "cafe",
        phone: "+351 210 000 000",
        openingHours: "Mo-Fr 08:00-18:00",
      });
      expect(view?.tags.map((tag) => tag.name)).toEqual(
        expect.arrayContaining(["Coffee", "Quiet"]),
      );
      expect(view?.place.externalRefs?.map((ref) => ref.url)).toEqual(
        expect.arrayContaining([googleUrl, webUrl]),
      );
      expect(await repo.listNotesForPlace(view?.place.id ?? "missing")).toEqual([
        expect.objectContaining({ body: "Window table" }),
      ]);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 exact-reference dedup audit", () => {
  it("reuses an existing historical OSM match when the imported old anchor is gone", async () => {
    const repo = new DexieRepository(`phase3-historical-anchor-${crypto.randomUUID()}`);
    const oldPoi = poi("800", "Café before redraw");
    const replacement = poi("801", "Café after redraw", {
      osmRef: { type: "way", id: "801" },
    });
    const deps = providers({
      resolveExact: vi.fn(async () => ({ type: "gone" as const })),
    });

    try {
      await repo.createList({ id: "existing", name: "Existing", createdAt: NOW, updatedAt: NOW });
      const original = await repo.addToList("existing", { kind: "poi", poi: oldPoi }, NOW);
      await repo.updatePlace(
        linkPlaceToOsm(original.place, replacement, "2026-07-20T10:00:00.000Z", "resolver-match"),
      );

      const report = await runImport(
        repo,
        {
          name: "Imported.csv",
          bytes: strToU8(
            "Title,Note,URL,Address\nCafé before redraw,,https://www.openstreetmap.org/node/800,\n",
          ),
        },
        deps,
        "2026-07-20T12:00:00.000Z",
      );

      expect(report).toMatchObject({ placed: 1, linked: 1, review: 0 });
      expect(await repo.listPlaces()).toHaveLength(1);
      const memberships = await repo.listIdsForPlace(original.place.id);
      expect(memberships).toContain("existing");
      expect(memberships).toHaveLength(2);
    } finally {
      repo.db.close();
    }
  });

  it("reuses a known exact OSM match when the resolver is unavailable", async () => {
    const repo = new DexieRepository(`phase3-local-anchor-offline-${crypto.randomUUID()}`);
    const current = poi("850", "Current OSM name");
    const deps = providers({
      resolveExact: vi.fn(async () => {
        throw new Error("resolver offline");
      }),
    });

    try {
      await repo.createList({ id: "existing", name: "Existing", createdAt: NOW, updatedAt: NOW });
      const original = await repo.addToList("existing", { kind: "poi", poi: current }, NOW);

      const report = await runImport(
        repo,
        {
          name: "Imported.csv",
          bytes: strToU8(
            "Title,Note,URL,Address\nFormer OSM name,,https://www.openstreetmap.org/node/850,\n",
          ),
        },
        deps,
        "2026-07-20T12:00:00.000Z",
      );

      expect(report).toMatchObject({ placed: 1, linked: 1, review: 0 });
      expect((await repo.listPlaces()).map((view) => view.place.id)).toEqual([original.place.id]);
      expect(await repo.listIdsForPlace(original.place.id)).toHaveLength(2);
    } finally {
      repo.db.close();
    }
  });

  it("retains imported facts when dedup reuses an OSM-origin place", async () => {
    const repo = new DexieRepository(`phase3-osm-dedup-facts-${crypto.randomUUID()}`);
    const existingPoi = poi("300", "Café Central", { address: "OSM address" });
    const searchResult: SearchResult = {
      ref: existingPoi.osmRef,
      name: "Café Central",
      address: "12 Imported Street, Lisbon",
      category: "cafe",
      lat: existingPoi.lat,
      lng: existingPoi.lng,
    };
    const deps = providers({
      search: [searchResult],
      resolveExact: vi.fn(async () => ({ type: "ok" as const, poi: existingPoi })),
    });

    try {
      await repo.createList({ id: "existing", name: "Existing", createdAt: NOW, updatedAt: NOW });
      const original = await repo.addToList("existing", { kind: "poi", poi: existingPoi }, NOW);
      const googleUrl = "https://www.google.com/maps/place/Cafe/data=!4m2!3m1!1s0xabc:0xdef";

      await runImport(
        repo,
        {
          name: "Imported.csv",
          bytes: strToU8(
            `Title,Note,URL,Address\nCafé Central,,${googleUrl},"12 Imported Street, Lisbon"\n`,
          ),
        },
        deps,
        NOW,
      );

      expect(await repo.getPlace(original.place.id)).toMatchObject({
        id: original.place.id,
        origin: "osm",
        manual: {
          name: "Café Central",
          address: "12 Imported Street, Lisbon",
          lat: existingPoi.lat,
          lng: existingPoi.lng,
        },
        externalRefs: [expect.objectContaining({ provider: "google-maps", url: googleUrl })],
      });
    } finally {
      repo.db.close();
    }
  });

  it("reports an exact-ref re-import as a duplicate after the OSM name changes", async () => {
    const repo = new DexieRepository(`phase3-exact-rename-${crypto.randomUUID()}`);
    const current = poi("301", "Current OSM name");
    const deps = providers({
      resolveExact: vi.fn(async () => ({ type: "ok" as const, poi: current })),
    });

    try {
      await repo.createList({ id: "trip", name: "Trip", createdAt: NOW, updatedAt: NOW });
      const original = await repo.addToList("trip", { kind: "poi", poi: current }, NOW);

      const report = await runImport(
        repo,
        geoJsonFile("Trip.geojson", { name: "Former OSM name", osmRef: "node/301" }),
        deps,
        "2026-07-20T12:00:00.000Z",
      );

      expect(report).toMatchObject({ placed: 0, duplicates: 1, review: 0 });
      expect((await repo.listPlaces()).map((view) => view.place.id)).toEqual([original.place.id]);
    } finally {
      repo.db.close();
    }
  });

  it("gives an exact OSM ref precedence over a nearby same-name place with another ref", async () => {
    const repo = new DexieRepository(`phase3-exact-precedence-${crypto.randomUUID()}`);
    const existing = poi("401", "Same name");
    const imported = poi("402", "Same name");
    const deps = providers({
      resolveExact: vi.fn(async (ref) =>
        ref.type === imported.osmRef.type && ref.id === imported.osmRef.id
          ? { type: "ok" as const, poi: imported }
          : { type: "gone" as const },
      ),
    });

    try {
      await repo.createList({ id: "trip", name: "Trip", createdAt: NOW, updatedAt: NOW });
      await repo.addToList("trip", { kind: "poi", poi: existing }, NOW);

      const report = await runImport(
        repo,
        geoJsonFile("Trip.geojson", { name: "Same name", osmRef: "node/402" }),
        deps,
        NOW,
      );

      expect(report).toMatchObject({ placed: 1, linked: 1, duplicates: 0 });
      const exact = await repo.findPlaceByOsmRef(imported.osmRef);
      expect(exact?.currentOsmRef).toEqual(imported.osmRef);
      expect(await repo.listIdsForPlace(exact?.id ?? "missing")).toContain("trip");
      expect(await repo.listPlaces()).toHaveLength(2);
    } finally {
      repo.db.close();
    }
  });

  it("does not accept a radically incompatible exact result for an imported OSM anchor", async () => {
    const repo = new DexieRepository(`phase3-exact-repurposed-${crypto.randomUUID()}`);
    const repurposed = poi("501", "Industrial warehouse", {
      category: "industrial",
      lat: 52.5,
      lng: 13.4,
      identityTags: { building: "industrial", name: "Industrial warehouse" },
    });
    const deps = providers({
      resolveExact: vi.fn(async () => ({ type: "ok" as const, poi: repurposed })),
    });

    try {
      const report = await runImport(
        repo,
        geoJsonFile("old-export.geojson", {
          name: "Neighbourhood Café",
          category: "cafe",
          osmRef: "node/501",
        }),
        deps,
        NOW,
      );

      expect(report).toMatchObject({ placed: 0, linked: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
    } finally {
      repo.db.close();
    }
  });

  it("does not accept an incompatible exact OSM result merely because CSV has no coordinates", async () => {
    const repo = new DexieRepository(`phase3-csv-repurposed-${crypto.randomUUID()}`);
    const repurposed = poi("550", "Industrial warehouse", {
      category: "industrial",
      address: "99 Factory Road, Berlin",
      identityTags: { building: "industrial", name: "Industrial warehouse" },
    });
    const deps = providers({
      resolveExact: vi.fn(async () => ({ type: "ok" as const, poi: repurposed })),
    });

    try {
      const report = await runImport(
        repo,
        {
          name: "old-export.csv",
          bytes: strToU8(
            'Title,Note,URL,Address\n"Neighbourhood Café",,https://www.openstreetmap.org/node/550,"12 Old Street, Lisbon"\n',
          ),
        },
        deps,
        NOW,
      );

      expect(report).toMatchObject({ placed: 0, linked: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 3 conservative geocoding and accounting audit", () => {
  it("does not deduplicate distinct places solely because they share a generic web URL", async () => {
    const repo = new DexieRepository(`phase3-shared-web-url-${crypto.randomUUID()}`);
    const sharedUrl = "https://chain.example/locations";
    const bytes = strToU8(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-9.14, 38.71] },
            properties: { name: "North branch", externalUrls: [sharedUrl] },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-8.61, 41.15] },
            properties: { name: "South branch", externalUrls: [sharedUrl] },
          },
        ],
      }),
    );

    try {
      const report = await runImport(repo, { name: "branches.geojson", bytes }, providers(), NOW);

      expect(report).toMatchObject({ placed: 2, duplicates: 0, review: 0 });
      expect(await repo.listPlaces()).toHaveLength(2);
    } finally {
      repo.db.close();
    }
  });

  it("does not arbitrarily choose among multiple name-and-proximity dedup targets", async () => {
    const repo = new DexieRepository(`phase3-local-dedup-ambiguity-${crypto.randomUUID()}`);

    try {
      await repo.createList({ id: "first", name: "First", createdAt: NOW, updatedAt: NOW });
      await repo.createList({ id: "second", name: "Second", createdAt: NOW, updatedAt: NOW });
      await repo.addToList(
        "first",
        { kind: "manual", facts: { name: "Common name", lat: 38.7138, lng: -9.1394 } },
        NOW,
      );
      await repo.addToList(
        "second",
        { kind: "manual", facts: { name: "Common name", lat: 38.714, lng: -9.1394 } },
        NOW,
      );

      const report = await runImport(
        repo,
        geoJsonFile("Target.geojson", { name: "Common name" }),
        providers(),
        NOW,
      );

      expect(report).toMatchObject({ placed: 0, duplicates: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(2);
    } finally {
      repo.db.close();
    }
  });

  it("does not auto-link a coordinate-less row from a name match alone", async () => {
    const repo = new DexieRepository(`phase3-name-only-${crypto.randomUUID()}`);
    const candidate: SearchResult = {
      ref: { type: "node", id: "601" },
      name: "Starbucks",
      category: "cafe",
      lat: 38.71,
      lng: -9.14,
    };
    const deps = providers({
      search: [candidate],
      resolveExact: vi.fn(async () => ({ type: "ok" as const, poi: poi("601", "Starbucks") })),
    });

    try {
      const report = await runImport(
        repo,
        { name: "chains.csv", bytes: strToU8("Title,Note,URL,Address\nStarbucks,,,\n") },
        deps,
        NOW,
      );

      expect(report).toMatchObject({ placed: 0, linked: 0, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
    } finally {
      repo.db.close();
    }
  });

  it("accounts for an identical unresolved row on re-import without duplicating queue state", async () => {
    const repo = new DexieRepository(`phase3-review-accounting-${crypto.randomUUID()}`);
    const file = {
      name: "unknown.csv",
      bytes: strToU8('Title,Note,URL,Address\n"Unknown place",,,Nowhere\n'),
    };
    const deps = providers();

    try {
      await runImport(repo, file, deps, NOW);
      const report = await runImport(repo, file, deps, "2026-07-20T12:00:00.000Z");
      const accounted = report.placed + report.duplicates + report.review + report.skipped;

      expect(accounted).toBe(1);
      expect(await repo.db.importItems.filter((item) => item.status === "review").count()).toBe(1);
    } finally {
      repo.db.close();
    }
  });

  it("uses newer source metadata when an unresolved row is re-imported", async () => {
    const repo = new DexieRepository(`phase3-review-newer-source-${crypto.randomUUID()}`);
    const deps = providers();
    const file = (note: string) => ({
      name: "unknown.csv",
      bytes: strToU8(`Title,Note,URL,Address\n"Unknown place","${note}",,"Nowhere Street"\n`),
    });

    try {
      await runImport(repo, file("Old source note"), deps, NOW);
      const second = await runImport(
        repo,
        file("New source note"),
        deps,
        "2026-07-20T12:00:00.000Z",
      );
      const rows = await repo.db.importItems.filter((item) => item.status === "review").toArray();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("missing persisted review row");
      expect(row.batchId).toBe(second.batchId);

      await resolveReviewItem(
        repo,
        deps,
        row.id,
        { kind: "coords", lat: 38.7139, lng: -9.1394 },
        "2026-07-20T12:05:00.000Z",
      );

      const place = (await repo.listPlaces())[0]?.place;
      expect(await repo.listNotesForPlace(place?.id ?? "missing")).toEqual([
        expect.objectContaining({ body: "New source note" }),
      ]);
    } finally {
      repo.db.close();
    }
  });

  it("retains a regional Google Maps URL as provenance and a deep link", async () => {
    const repo = new DexieRepository(`phase3-google-domain-${crypto.randomUUID()}`);
    const url = "https://maps.google.co.uk/maps/search/38.71,-9.15";

    try {
      await runImport(
        repo,
        {
          name: "regional.csv",
          bytes: strToU8(`Title,Note,URL,Address\nRegional pin,,${url},\n`),
        },
        providers(),
        NOW,
      );

      expect((await repo.listPlaces())[0]?.place.externalRefs ?? []).toContainEqual(
        expect.objectContaining({ provider: "google-maps", url }),
      );
    } finally {
      repo.db.close();
    }
  });
});
