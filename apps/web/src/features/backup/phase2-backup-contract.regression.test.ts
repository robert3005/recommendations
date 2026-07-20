import { markerAt, type ResolvedPoi } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T13:00:00.000Z";

type JsonObject = Record<string, unknown>;

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

function poi(): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: "Café Central", amenity: "cafe" },
    resolvedAt: NOW,
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

async function rewriteArchive(
  backup: Blob,
  mutate: (data: JsonObject, entries: Record<string, Uint8Array>, manifest: JsonObject) => void,
): Promise<Blob> {
  const entries = unzipSync(await blobBytes(backup));
  const data = JSON.parse(strFromU8(entries["data.json"] ?? new Uint8Array())) as JsonObject;
  const manifest = JSON.parse(
    strFromU8(entries["manifest.json"] ?? new Uint8Array()),
  ) as JsonObject;

  mutate(data, entries, manifest);
  const dataBytes = strToU8(JSON.stringify(data));
  entries["data.json"] = dataBytes;
  const checksums = manifest.checksums as Record<string, string>;
  checksums["data.json"] = await sha256Hex(dataBytes);
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));

  const zipped = zipSync(entries);
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

async function seedSource(repo: DexieRepository): Promise<void> {
  await repo.createList({
    id: "source-list",
    name: "Source",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.addToList("source-list", { kind: "poi", poi: poi() }, NOW);
}

async function seedTarget(repo: DexieRepository): Promise<void> {
  await repo.createList({
    id: "target-list",
    name: "Keep me",
    marker: markerAt(1),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.addToList(
    "target-list",
    { kind: "manual", facts: { name: "Existing pin", lat: 51.5, lng: -0.1 } },
    NOW,
  );
}

describe("Phase 2 validated backup restore contract", () => {
  it("rejects a live place without a live list membership before replace writes", async () => {
    const source = freshRepo("phase2-orphan-source");
    const target = freshRepo("phase2-orphan-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(
        await exportBackup(source, NOW),
        (data, _entries, manifest) => {
          data.listBlocks = [];
          (manifest.counts as Record<string, number>).listBlocks = 0;
        },
      );

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /membership|orphan|graph/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a malformed OSM reference before replace writes", async () => {
    const source = freshRepo("phase2-ref-source");
    const target = freshRepo("phase2-ref-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const places = data.places as Array<{ currentOsmRef: { id: string } }>;
        const place = places[0];
        if (!place) throw new Error("place fixture missing");
        place.currentOsmRef.id = "not-a-decimal-osm-id";
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /reference|OSM|id/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects live media metadata whose declared blob is absent", async () => {
    const source = freshRepo("phase2-media-source");
    const target = freshRepo("phase2-media-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(
        await exportBackup(source, NOW),
        (data, _entries, manifest) => {
          (data.mediaAssets as JsonObject[]).push({
            id: "media-1",
            mime: "image/webp",
            localBlobKey: "blob-1",
            createdAt: NOW,
            updatedAt: NOW,
          });
          (manifest.counts as Record<string, number>).mediaAssets = 1;
        },
      );

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(/media|bytes/i);
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("does not trust a colliding incoming PlaceId to overwrite a different OSM identity", async () => {
    const source = freshRepo("phase2-id-collision-source");
    const target = freshRepo("phase2-id-collision-target");
    try {
      await source.createList({
        id: "source-list",
        name: "Source",
        marker: markerAt(0),
        createdAt: LATER,
        updatedAt: LATER,
      });
      await source.addToList(
        "source-list",
        {
          kind: "poi",
          poi: { ...poi(), osmRef: { type: "way", id: "202" }, resolvedAt: LATER },
        },
        LATER,
      );
      await target.createList({
        id: "target-list",
        name: "Target",
        marker: markerAt(1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const targetPlace = await target.addToList("target-list", { kind: "poi", poi: poi() }, NOW);

      const archive = await rewriteArchive(await exportBackup(source, LATER), (data) => {
        const incomingPlace = (data.places as Array<{ id: string }>)[0];
        const incomingBlock = (
          data.listBlocks as Array<{
            refId: string;
            content: { type: "place"; placeId: string };
          }>
        )[0];
        if (!incomingPlace || !incomingBlock) throw new Error("identity fixture missing");
        incomingPlace.id = targetPlace.place.id;
        incomingBlock.refId = targetPlace.place.id;
        incomingBlock.content.placeId = targetPlace.place.id;
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(
        /collision|identity|PlaceId/i,
      );
      expect((await target.getPlace(targetPlace.place.id))?.currentOsmRef).toEqual({
        type: "node",
        id: "101",
      });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects duplicate entity ids instead of letting bulk restore overwrite one row", async () => {
    const source = freshRepo("phase2-duplicate-id-source");
    const target = freshRepo("phase2-duplicate-id-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(
        await exportBackup(source, NOW),
        (data, _entries, manifest) => {
          const lists = data.lists as JsonObject[];
          const list = lists[0];
          if (!list) throw new Error("list fixture missing");
          lists.push({ ...list });
          (manifest.counts as Record<string, number>).lists = lists.length;
        },
      );

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /duplicate|id/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a live place block that targets no live place", async () => {
    const source = freshRepo("phase2-dangling-block-source");
    const target = freshRepo("phase2-dangling-block-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(
        await exportBackup(source, NOW),
        (data, _entries, manifest) => {
          const blocks = data.listBlocks as JsonObject[];
          const block = blocks[0];
          if (!block) throw new Error("block fixture missing");
          blocks.push({
            ...block,
            id: "dangling-block",
            refId: "missing-place",
            content: { type: "place", placeId: "missing-place" },
          });
          (manifest.counts as Record<string, number>).listBlocks = blocks.length;
        },
      );

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /block|place|graph/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("validates OSM references inside copied first-seen evidence", async () => {
    const source = freshRepo("phase2-evidence-ref-source");
    const target = freshRepo("phase2-evidence-ref-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const place = (data.places as Array<{ firstSeen: { ref: { id: string } } }>)[0];
        if (!place) throw new Error("place fixture missing");
        place.firstSeen.ref.id = "malformed-evidence-ref";
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /reference|OSM|id/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("verifies every manifest-declared checksum, not only data and media", async () => {
    const source = freshRepo("phase2-declared-checksum-source");
    const target = freshRepo("phase2-declared-checksum-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(
        await exportBackup(source, NOW),
        (_data, entries, manifest) => {
          entries["unexpected.bin"] = strToU8("tampered bytes");
          (manifest.checksums as Record<string, string>)["unexpected.bin"] = "0".repeat(64);
        },
      );

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(/checksum/i);
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects empty entity ids even when their graph references are internally consistent", async () => {
    const source = freshRepo("phase2-empty-id-source");
    const target = freshRepo("phase2-empty-id-target");
    try {
      await seedSource(source);
      await seedTarget(target);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const list = (data.lists as Array<{ id: string }>)[0];
        const block = (data.listBlocks as Array<{ listId: string }>)[0];
        if (!list || !block) throw new Error("id fixture missing");
        list.id = "";
        block.listId = "";
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(/empty|id/i);
      expect((await target.listLists()).map((list) => list.id)).toContain("target-list");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("never lets stale derived refKeys fork the same exact OSM identity after restore", async () => {
    const source = freshRepo("phase2-ref-key-source");
    const target = freshRepo("phase2-ref-key-target");
    try {
      await seedSource(source);
      const sourcePlaceId = (await source.listPlaces())[0]?.place.id;
      if (!sourcePlaceId) throw new Error("place fixture missing");
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const place = (data.places as Array<{ refKeys: string[] }>)[0];
        if (!place) throw new Error("place fixture missing");
        place.refKeys = [];
      });

      try {
        await importBackup(target, archive, "replace", LATER);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/reference|refKeys|identity/i);
        return;
      }

      await target.createList({
        id: "second-list",
        name: "Second",
        marker: markerAt(1),
        createdAt: LATER,
        updatedAt: LATER,
      });
      const addedAgain = await target.addToList(
        "second-list",
        { kind: "poi", poi: { ...poi(), resolvedAt: LATER } },
        LATER,
      );
      expect(addedAgain.place.id).toBe(sourcePlaceId);
      expect(await target.listPlaces()).toHaveLength(1);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
