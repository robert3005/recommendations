import { markerAt, type ResolvedPoi } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T13:00:00.000Z";

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

function archive(entries: Record<string, Uint8Array>): Blob {
  const zipped = zipSync(entries);
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

describe("backup validation regressions", () => {
  it("rejects out-of-range coordinates before replacing local data", async () => {
    const source = freshRepo("backup-coordinate-source");
    const target = freshRepo("backup-coordinate-target");
    try {
      await source.createList({
        id: "source-list",
        name: "Source",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await source.addToList(
        "source-list",
        { kind: "manual", facts: { name: "Impossible pin", lat: 38.7, lng: -9.1 } },
        NOW,
      );
      const entries = unzipSync(await blobBytes(await exportBackup(source, NOW)));
      const data = JSON.parse(strFromU8(entries["data.json"] ?? new Uint8Array())) as {
        places: Array<{ manual?: { lat: number } }>;
      };
      if (!data.places[0]?.manual) throw new Error("manual place missing from fixture");
      data.places[0].manual.lat = 91;
      const dataBytes = strToU8(JSON.stringify(data));
      entries["data.json"] = dataBytes;

      const manifest = JSON.parse(strFromU8(entries["manifest.json"] ?? new Uint8Array())) as {
        checksums: Record<string, string>;
      };
      manifest.checksums["data.json"] = await sha256Hex(dataBytes);
      entries["manifest.json"] = strToU8(JSON.stringify(manifest));

      await expect(importBackup(target, archive(entries), "replace", LATER)).rejects.toThrow(
        /coordinate/i,
      );
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects media whose bytes no longer match the backup manifest", async () => {
    const source = freshRepo("backup-media-source");
    const target = freshRepo("backup-media-target");
    try {
      const entries = unzipSync(await blobBytes(await exportBackup(source, NOW)));
      const data = JSON.parse(strFromU8(entries["data.json"] ?? new Uint8Array())) as {
        mediaAssets: Array<Record<string, unknown>>;
      };
      data.mediaAssets.push({
        id: "media-1",
        mime: "image/webp",
        localBlobKey: "blob-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const dataBytes = strToU8(JSON.stringify(data));
      entries["data.json"] = dataBytes;

      const manifest = JSON.parse(strFromU8(entries["manifest.json"] ?? new Uint8Array())) as {
        checksums: Record<string, string>;
      };
      manifest.checksums["data.json"] = await sha256Hex(dataBytes);
      manifest.checksums["media/blob-1"] = await sha256Hex(strToU8("original image bytes"));
      entries["manifest.json"] = strToU8(JSON.stringify(manifest));
      entries["media/blob-1"] = strToU8("tampered image bytes");

      await expect(importBackup(target, archive(entries), "replace", LATER)).rejects.toThrow(
        /checksum/i,
      );
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe("backup identity merge", () => {
  it("deduplicates the same exact OSM element across different PlaceIds", async () => {
    const source = freshRepo("backup-merge-source");
    const target = freshRepo("backup-merge-target");
    try {
      await source.createList({
        id: "source-list",
        name: "Source",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await source.addToList("source-list", { kind: "poi", poi: poi() }, NOW);
      const backup = await exportBackup(source, NOW);

      await target.createList({
        id: "target-list",
        name: "Target",
        marker: markerAt(1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await target.addToList("target-list", { kind: "poi", poi: poi() }, NOW);
      await importBackup(target, backup, "merge", LATER);

      const places = await target.listPlaces();
      expect(places).toHaveLength(1);
      const place = places[0]?.place;
      if (!place) throw new Error("merged place missing");
      expect((await target.listIdsForPlace(place.id)).sort()).toEqual([
        "source-list",
        "target-list",
      ]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
