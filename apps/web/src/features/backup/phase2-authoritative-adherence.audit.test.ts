import { linkPlaceToOsm, markerAt, type ResolvedPoi } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, INFLATED_BYTE_LIMIT, importBackup } from "./backup";

vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return { ...actual, unzipSync: vi.fn(actual.unzipSync) };
});

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-19T12:00:00.000Z";

type JsonRow = { id: string; [key: string]: unknown };
type BackupJson = Record<string, JsonRow[]>;

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

function poi(overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Cafe Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: "Cafe Central", amenity: "cafe", wikidata: "Q101" },
    resolvedAt: NOW,
    ...overrides,
  };
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rewriteArchive(backup: Blob, mutate: (data: BackupJson) => void): Promise<Blob> {
  const entries = unzipSync(await blobBytes(backup));
  const dataBytes = entries["data.json"];
  const manifestBytes = entries["manifest.json"];
  if (!dataBytes || !manifestBytes) throw new Error("backup fixture is incomplete");
  const data = JSON.parse(strFromU8(dataBytes)) as BackupJson;
  const manifest = JSON.parse(strFromU8(manifestBytes)) as {
    checksums: Record<string, string>;
    counts: Record<string, number>;
  };

  mutate(data);
  const rewritten = strToU8(JSON.stringify(data));
  entries["data.json"] = rewritten;
  manifest.checksums["data.json"] = await sha256Hex(rewritten);
  manifest.counts = Object.fromEntries(
    Object.entries(data).map(([table, rows]) => [table, rows.length]),
  );
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  const zipped = zipSync(entries);
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

// Live list markers are unique (colour, icon) pairs — a global counter keeps
// every fixture list distinct even across merged libraries.
let markerCounter = 0;
const nextMarker = () => markerAt(markerCounter++);

async function seedOsmPlace(
  repo: DexieRepository,
  listId: string,
  observation: ResolvedPoi = poi(),
  at = observation.resolvedAt,
): Promise<string> {
  await repo.createList({
    id: listId,
    name: listId,
    marker: nextMarker(),
    createdAt: at,
    updatedAt: at,
  });
  return (await repo.addToList(listId, { kind: "poi", poi: observation }, at)).place.id;
}

function forgeCentralDirectoryInflatedSize(
  bytes: Uint8Array,
  uncompressedSize: number,
): Uint8Array {
  const forged = bytes.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  for (let offset = 0; offset <= forged.length - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(forged.subarray(offset + 46, offset + 46 + nameLength));
    if (name !== "data.json") continue;
    view.setUint32(offset + 24, uncompressedSize, true);
    return forged;
  }
  throw new Error("data.json central-directory entry not found");
}

describe("Phase 2 authoritative place identity", () => {
  it("never lets a manual-to-OSM upgrade fork an exact OSM ref across two PlaceIds", async () => {
    const repo = freshRepo("phase2-manual-link-ref-collision");
    try {
      await seedOsmPlace(repo, "osm-list");
      await repo.createList({
        id: "manual-list",
        name: "manual-list",
        marker: nextMarker(),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const manual = await repo.addToList(
        "manual-list",
        { kind: "manual", facts: { name: "My cafe", lat: 38.7139, lng: -9.1394 } },
        NOW,
      );
      const linked = linkPlaceToOsm(
        manual.place,
        poi({ resolvedAt: LATER }),
        LATER,
        "owner-confirmed",
      );

      // A compliant repository may merge the identities or refuse the upgrade for
      // explicit review. It must never persist two live PlaceIds for one exact ref.
      await repo.updatePlace(linked).catch(() => undefined);

      const exactMatches = (await repo.listPlaces()).filter(
        ({ place }) => place.currentOsmRef?.type === "node" && place.currentOsmRef.id === "101",
      );
      expect(exactMatches).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });

  it("does not overwrite last-verified evidence when a reused exact element looks repurposed", async () => {
    const repo = freshRepo("phase2-repurposed-ref-add");
    try {
      const placeId = await seedOsmPlace(repo, "first-list");
      await repo.createList({
        id: "second-list",
        name: "second-list",
        marker: nextMarker(),
        createdAt: LATER,
        updatedAt: LATER,
      });
      const repurposed = poi({
        name: "Auto Parts Warehouse",
        category: "car_parts",
        lat: 40.7,
        lng: -7.1,
        identityTags: { name: "Auto Parts Warehouse", shop: "car_parts" },
        resolvedAt: LATER,
      });

      let refused = false;
      try {
        await repo.addToList("second-list", { kind: "poi", poi: repurposed }, LATER);
      } catch {
        // Refusing the conflation pending review is also conservative.
        refused = true;
      }

      const stored = await repo.getPlace(placeId);
      expect(stored?.lastVerified?.name).toBe("Cafe Central");
      if (!refused) expect(stored?.resolutionState).toBe("needs-review");
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 2 authoritative local graph", () => {
  it("does not persist a live note whose target does not exist", async () => {
    const repo = freshRepo("phase2-orphan-note");
    try {
      await expect(
        repo.createNote({
          id: "orphan-note",
          target: { kind: "place", placeId: "missing-place" },
          body: "This note has no aggregate owner",
          mediaIds: [],
          shareable: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).rejects.toThrow(/target|place|not found|graph/i);
      expect(await repo.db.notes.get("orphan-note")).toBeUndefined();
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 2 authoritative backup validation", () => {
  it("rejects an OSM-origin place with no binding or copied evidence before replacing data", async () => {
    const source = freshRepo("phase2-invalid-osm-shape-source");
    const target = freshRepo("phase2-invalid-osm-shape-target");
    try {
      await seedOsmPlace(source, "source-list");
      await seedOsmPlace(target, "target-list", poi({ osmRef: { type: "node", id: "900" } }));
      const malformed = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const place = data.places?.[0];
        if (!place) throw new Error("place fixture missing");
        delete place.currentOsmRef;
        delete place.currentOsmLinkedAt;
        delete place.firstSeen;
        delete place.lastVerified;
        place.refKeys = [];
      });

      await expect(importBackup(target, malformed, "replace", LATER)).rejects.toThrow(
        /OSM|binding|evidence|schema|place/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("applies tag tombstone LWW before accepting the final merged graph", async () => {
    const source = freshRepo("phase2-tag-lww-source");
    const target = freshRepo("phase2-tag-lww-target");
    try {
      await seedOsmPlace(source, "source-list");
      const sourcePlace = (await source.listPlaces())[0]?.place;
      if (!sourcePlace) throw new Error("source place fixture missing");
      await source.assignTag(sourcePlace.id, "coffee", NOW);
      await seedOsmPlace(target, "target-list");
      await target.db.tags.put({
        id: "shared-tag",
        name: "coffee",
        nameNorm: "coffee",
        createdAt: NOW,
        updatedAt: LATER,
        deleted: true,
      });

      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const tag = data.tags?.[0];
        const assignment = data.tagAssignments?.[0];
        if (!tag || !assignment) throw new Error("tag fixture missing");
        tag.id = "shared-tag";
        assignment.tagId = "shared-tag";
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(
        /tag|tombstone|graph/i,
      );
      expect(
        (await target.db.tagAssignments.toArray()).filter(
          (assignment) => !assignment.deleted && assignment.tagId === "shared-tag",
        ),
      ).toHaveLength(0);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("coalesces an exact OSM ref before LWW merge without discarding newer evidence", async () => {
    const source = freshRepo("phase2-coalesced-evidence-source");
    const target = freshRepo("phase2-coalesced-evidence-target");
    try {
      await seedOsmPlace(
        source,
        "source-list",
        poi({ website: "https://new.example/", resolvedAt: LATER }),
        LATER,
      );
      const retainedId = await seedOsmPlace(target, "target-list", poi(), NOW);

      await importBackup(target, await exportBackup(source, LATER), "merge", LATER);

      const merged = await target.getPlace(retainedId);
      expect(await target.listPlaces()).toHaveLength(1);
      expect(merged?.firstSeen?.observedAt).toBe(NOW);
      expect(merged?.lastVerified?.observedAt).toBe(LATER);
      expect(merged?.lastVerified?.website).toBe("https://new.example/");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects an excessive central-directory inflated size before invoking unzip", async () => {
    const source = freshRepo("phase2-pre-decompression-limit-source");
    const target = freshRepo("phase2-pre-decompression-limit-target");
    try {
      const forgedBytes = forgeCentralDirectoryInflatedSize(
        await blobBytes(await exportBackup(source, NOW)),
        INFLATED_BYTE_LIMIT + 1,
      );
      const forged = new Blob([forgedBytes.slice().buffer as ArrayBuffer], {
        type: "application/zip",
      });
      const unzip = vi.mocked(unzipSync);
      unzip.mockClear();
      let decompressionStarted = false;
      unzip.mockImplementationOnce(() => {
        decompressionStarted = true;
        throw new Error("unsafe decompression was invoked");
      });

      let rejection: unknown;
      try {
        await importBackup(target, forged, "replace", LATER);
      } catch (error) {
        rejection = error;
      }

      expect(decompressionStarted).toBe(false);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/inflate|uncompressed|expanded|size limit/i);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
