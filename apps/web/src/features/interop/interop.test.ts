/**
 * Import pipeline invariants (spec/src/interop.md): URL forensics, parser edge
 * cases (quoting, the [0,0] bug, CSV↔GeoJSON cross-ref), the coordinate ladder
 * (auto-link / review / placed-unlinked), idempotent re-import, and the
 * every-row-accounted-for report.
 */
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { OsmApiResolver } from "../../providers/osmApi";
import { PhotonSearchProvider } from "../../providers/photon";
import { googleFeatureId, googleUrlCoords } from "./googleUrl";
import { type ImportDeps, resolveReviewItem, runImport } from "./importer";
import { parseSavedCsv, parseTakeoutZip } from "./parse";

const NOW = "2026-07-18T12:00:00.000Z";
const PLACE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";
const PIN_URL = "https://www.google.com/maps/search/38.71000,-9.15000";

function deps(): ImportDeps {
  const overpassLess = new OsmApiResolver();
  return {
    search: new PhotonSearchProvider(),
    resolver: {
      resolveExact: (ref, opts) => overpassLess.resolveExact(ref, opts),
      searchNearby: () => Promise.resolve([]),
      discover: () => Promise.resolve({ pois: [], truncated: false }),
    },
  };
}

describe("google url forensics", () => {
  it("extracts the feature-id pair and cid", () => {
    expect(googleFeatureId(PLACE_URL)).toBe("0x1f9a2b:0xdeadbeef");
    expect(googleFeatureId("https://maps.google.com/?cid=123456")).toBe("cid:123456");
    expect(googleFeatureId("https://www.google.com/maps/search/lisbon")).toBeUndefined();
  });

  it("extracts dropped-pin coordinates and rejects out-of-range values", () => {
    expect(googleUrlCoords(PIN_URL)).toEqual({ lat: 38.71, lng: -9.15 });
    expect(googleUrlCoords("https://maps.google.com/?q=38.7,-9.1")).toEqual({
      lat: 38.7,
      lng: -9.1,
    });
    expect(googleUrlCoords("https://www.google.com/maps/search/91.0,-9.1")).toBeUndefined();
    expect(googleUrlCoords(PLACE_URL)).toBeUndefined();
  });
});

describe("takeout parsers", () => {
  it("parses quoted CSV rows and counts unusable ones", () => {
    const csv = [
      "Title,Note,URL,Address",
      `"Café Central","Great bica, sit outside","${PLACE_URL}","Rua Example 12, Lisboa"`,
      `,"row without a title",,`,
    ].join("\n");
    const list = parseSavedCsv(csv, "Lisbon trip");
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      title: "Café Central",
      note: "Great bica, sit outside",
      address: "Rua Example 12, Lisboa",
    });
    expect(list.unusable).toHaveLength(1);
  });

  it("cross-references CSV rows with Saved Places.json and skips the [0,0] bug", () => {
    const savedPlaces = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
          properties: { Title: "Café Central", "Google Maps URL": PLACE_URL },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { Title: "Zero Island", "Google Maps URL": "https://maps.google.com/?cid=9" },
        },
      ],
    };
    const zip = zipSync({
      "Takeout/Saved/Lisbon trip.csv": strToU8(
        `Title,Note,URL,Address\n"Café Central",,"${PLACE_URL}",\n"Zero Island",,"https://maps.google.com/?cid=9",\n`,
      ),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(JSON.stringify(savedPlaces)),
    });
    const parsed = parseTakeoutZip(zip);
    expect(parsed.lists).toHaveLength(1);
    const [central, zero] = parsed.lists[0]?.items ?? [];
    expect(central?.coords).toEqual({ lat: 38.7139, lng: -9.1394 });
    expect(zero?.coords).toBeUndefined(); // the [0,0] bug must not place a row
  });
});

describe("import pipeline", () => {
  let repo: DexieRepository;
  beforeEach(() => {
    repo = new DexieRepository(`interop-${crypto.randomUUID()}`);
  });

  function takeout(): { name: string; bytes: Uint8Array } {
    const csv = [
      "Title,Note,URL,Address",
      `"Café Central","Great bica","${PLACE_URL}","Rua Example 12, Lisboa"`,
      `"Dropped pin",,"${PIN_URL}",`,
      `"Mystery Bar",,,"Nowhere 1"`,
    ].join("\n");
    return {
      name: "takeout.zip",
      bytes: zipSync({ "Takeout/Saved/Lisbon trip.csv": strToU8(csv) }),
    };
  }

  it("runs the coordinate ladder: auto-link, placed-unlinked, review", async () => {
    try {
      const report = await runImport(repo, takeout(), deps(), NOW);
      expect(report).toMatchObject({ lists: 1, placed: 2, linked: 1, review: 1, skipped: 0 });

      const lists = await repo.listLists();
      expect(lists.map((l) => l.name)).toEqual(["Lisbon trip"]);
      const places = await repo.listPlaces();
      expect(places).toHaveLength(2);

      const central = places.find((p) => p.place.currentOsmRef);
      expect(central?.place.currentOsmRef).toEqual({ type: "node", id: "101" });
      expect(central?.place.externalRefs?.[0]?.fid).toBe("0x1f9a2b:0xdeadbeef");
      const notes = central ? await repo.listNotesForPlace(central.place.id) : [];
      expect(notes.map((n) => n.body)).toEqual(["Great bica"]);

      const pin = places.find((p) => !p.place.currentOsmRef);
      expect(pin?.place.origin).toBe("import");
      expect(pin?.place.resolutionState).toBe("unlinked");
      expect(pin?.place.manual).toMatchObject({ lat: 38.71, lng: -9.15 });
    } finally {
      repo.db.close();
    }
  });

  it("re-import converges: no new places, rows become duplicates", async () => {
    try {
      await runImport(repo, takeout(), deps(), NOW);
      const again = await runImport(repo, takeout(), deps(), "2026-07-19T09:00:00.000Z");
      expect(again).toMatchObject({ placed: 0, duplicates: 2, review: 1 });
      expect(await repo.listPlaces()).toHaveLength(2);
      expect((await repo.listLists()).map((l) => l.name)).toEqual(["Lisbon trip"]);
      // The imported note is not duplicated either.
      const central = (await repo.listPlaces()).find((p) => p.place.currentOsmRef);
      const notes = central ? await repo.listNotesForPlace(central.place.id) : [];
      expect(notes).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });

  it("review items resolve by candidate pick, manual coords, or skip", async () => {
    try {
      await runImport(repo, takeout(), deps(), NOW);
      const reviewItems = await repo.db.importItems.filter((i) => i.status === "review").toArray();
      expect(reviewItems).toHaveLength(1);
      const mystery = reviewItems[0];
      if (!mystery) throw new Error("missing review item");
      expect(mystery.raw.title).toBe("Mystery Bar");

      await resolveReviewItem(
        repo,
        deps(),
        mystery.id,
        { kind: "coords", lat: 38.7, lng: -9.14 },
        NOW,
      );
      const resolved = await repo.db.importItems.get(mystery.id);
      expect(resolved?.status).toBe("placed");
      expect(await repo.listPlaces()).toHaveLength(3);
      const batch = await repo.db.importBatches.get(mystery.batchId);
      expect(batch?.status).toBe("done");
    } finally {
      repo.db.close();
    }
  });
});

describe("import dedup in the repository", () => {
  it("the same external ref converges on one place across lists", async () => {
    const repo = new DexieRepository(`interop-dedup-${crypto.randomUUID()}`);
    try {
      const ref = {
        provider: "google-maps" as const,
        url: PLACE_URL,
        fid: "0x1f9a2b:0xdeadbeef",
        importedAt: NOW,
      };
      await repo.createList({ id: "a", name: "A", createdAt: NOW, updatedAt: NOW });
      await repo.createList({ id: "b", name: "B", createdAt: NOW, updatedAt: NOW });
      const first = await repo.addToList(
        "a",
        {
          kind: "import",
          facts: { name: "Café Central", lat: 38.7139, lng: -9.1394 },
          externalRef: ref,
        },
        NOW,
      );
      const second = await repo.addToList(
        "b",
        // Slightly different facts — the external ref still wins.
        {
          kind: "import",
          facts: { name: "Cafe Central", lat: 38.7141, lng: -9.1392 },
          externalRef: ref,
        },
        NOW,
      );
      expect(second.place.id).toBe(first.place.id);
      expect((await repo.listIdsForPlace(first.place.id)).sort()).toEqual(["a", "b"]);
      expect(second.place.externalRefs).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });

  it("name+proximity dedups against an existing place; distance alone never does", async () => {
    const repo = new DexieRepository(`interop-nearby-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "a", name: "A", createdAt: NOW, updatedAt: NOW });
      const first = await repo.addToList(
        "a",
        { kind: "manual", facts: { name: "Picnic bench", lat: 38.7, lng: -9.14 } },
        NOW,
      );
      await repo.createList({ id: "b", name: "B", createdAt: NOW, updatedAt: NOW });
      const same = await repo.addToList(
        "b",
        { kind: "import", facts: { name: "picnic bench", lat: 38.7003, lng: -9.1401 } },
        NOW,
      );
      expect(same.place.id).toBe(first.place.id);

      const different = await repo.addToList(
        "b",
        { kind: "import", facts: { name: "Another spot", lat: 38.7003, lng: -9.1401 } },
        NOW,
      );
      expect(different.place.id).not.toBe(first.place.id);
    } finally {
      repo.db.close();
    }
  });
});
