/** Residual backup/restore regressions found while auditing Phase 2 at 15c3d8e. */
import { markerAt, type ResolvedPoi } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";
const LATEST = "2026-07-19T12:00:00.000Z";

type MutableRow = { id: string; [key: string]: unknown };
type MutableData = Record<string, MutableRow[]>;

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

function poi(): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Cafe Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: "Cafe Central", amenity: "cafe" },
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

async function rewriteArchive(backup: Blob, mutate: (data: MutableData) => void): Promise<Blob> {
  const entries = unzipSync(await blobBytes(backup));
  const dataBytes = entries["data.json"];
  const manifestBytes = entries["manifest.json"];
  if (!dataBytes || !manifestBytes) throw new Error("backup fixture is incomplete");
  const data = JSON.parse(strFromU8(dataBytes)) as MutableData;
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

async function seed(repo: DexieRepository) {
  await repo.createList({
    id: "list-1",
    name: "Trip",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const place = (await repo.addToList("list-1", { kind: "poi", poi: poi() }, NOW)).place;
  await repo.createNote({
    id: "note-1",
    target: { kind: "place", placeId: place.id },
    body: "archived body",
    shareable: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return place;
}

describe("Phase 2 residual backup merge behavior", () => {
  it("preserves both note bodies when the incoming conflicting note is older", async () => {
    const source = freshRepo("phase2-residual-old-conflict-source");
    const target = freshRepo("phase2-residual-old-conflict-target");
    try {
      const place = await seed(source);
      const olderBackup = await exportBackup(source, NOW);
      await importBackup(target, olderBackup, "replace", NOW);
      const local = (await target.listNotesForPlace(place.id))[0];
      if (!local) throw new Error("note fixture is missing");
      await target.updateNote({ ...local, body: "newer local body", updatedAt: LATER });

      const result = await importBackup(target, olderBackup, "merge", LATEST);

      expect(result.conflictCopies).toBe(1);
      expect((await target.listNotesForPlace(place.id)).map((note) => note.body).sort()).toEqual([
        "archived body",
        "newer local body",
      ]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe("Phase 2 residual backup identity validation", () => {
  it("rejects an OSM-origin place that retained evidence but lost its current binding", async () => {
    const source = freshRepo("phase2-residual-osm-binding-source");
    const target = freshRepo("phase2-residual-osm-binding-target");
    try {
      await seed(source);
      const malformed = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const place = data.places?.[0];
        if (!place) throw new Error("place fixture is missing");
        delete place.currentOsmRef;
        delete place.currentOsmLinkedAt;
        place.resolutionState = "unlinked";
      });

      await expect(importBackup(target, malformed, "replace", LATER)).rejects.toThrow(
        /OSM|origin|binding|place|schema/i,
      );
      expect(await target.listPlaces()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a completed OSM history interval with no linkedAt timestamp", async () => {
    const source = freshRepo("phase2-residual-history-shape-source");
    const target = freshRepo("phase2-residual-history-shape-target");
    try {
      await seed(source);
      const malformed = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const place = data.places?.[0];
        if (!place) throw new Error("place fixture is missing");
        place.osmRefHistory = [
          {
            ref: { type: "way", id: "999" },
            unlinkedAt: NOW,
            reason: "replaced",
          },
        ];
      });

      await expect(importBackup(target, malformed, "replace", LATER)).rejects.toThrow(
        /history|interval|linkedAt|schema|place/i,
      );
      expect(await target.listPlaces()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
