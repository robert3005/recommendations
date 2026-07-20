/**
 * Merge and identity-shape regressions from spec/src/storage-sync.md.
 * These cases focus on final-state LWW/edge invariants not exercised by the
 * existing replace-graph and identity-coalescing audit suites.
 */
import { markerAt, type Note } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

type MutableRow = { id: string; [key: string]: unknown };
type MutableData = Record<string, MutableRow[]>;

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
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

// Live list markers are unique (colour, icon) pairs; a counter keeps fixture
// lists distinct even across merged libraries.
let markerCounter = 0;

async function seedManual(repo: DexieRepository, listId = "list-1"): Promise<string> {
  await repo.createList({
    id: listId,
    name: listId,
    marker: markerAt(markerCounter++),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return (
    await repo.addToList(
      listId,
      { kind: "manual", facts: { name: "Manual pin", lat: 38.7139, lng: -9.1394 } },
      NOW,
    )
  ).place.id;
}

function row(data: MutableData, table: string, predicate: (value: MutableRow) => boolean) {
  const found = data[table]?.find(predicate);
  if (!found) throw new Error(`${table} fixture is missing`);
  return found;
}

describe("Phase 2 backup place-shape and attribution validation", () => {
  it("rejects a linked manual place with no copied first/last OSM evidence", async () => {
    const source = freshRepo("phase2-linked-manual-shape-source");
    const target = freshRepo("phase2-linked-manual-shape-target");
    try {
      await seedManual(source);
      await seedManual(target, "retained-list");
      const malformed = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const place = row(data, "places", () => true);
        place.currentOsmRef = { type: "node", id: "101" };
        place.currentOsmLinkedAt = LATER;
        place.resolutionState = "resolved";
        place.refKeys = ["node/101"];
        delete place.firstSeen;
        delete place.lastVerified;
      });

      await expect(importBackup(target, malformed, "replace", LATER)).rejects.toThrow(
        /evidence|linked|OSM|place/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toEqual(["retained-list"]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects copied OSM evidence with false source, licence, or attribution claims", async () => {
    const source = freshRepo("phase2-evidence-attribution-source");
    const target = freshRepo("phase2-evidence-attribution-target");
    try {
      await source.createList({
        id: "source-list",
        name: "source-list",
        marker: markerAt(markerCounter++),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await source.addToList(
        "source-list",
        {
          kind: "poi",
          poi: {
            osmRef: { type: "node", id: "101" },
            name: "OSM place",
            category: "cafe",
            lat: 38.7139,
            lng: -9.1394,
            identityTags: { name: "OSM place", amenity: "cafe" },
            resolvedAt: NOW,
          },
        },
        NOW,
      );
      const malformed = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const place = row(data, "places", () => true);
        for (const key of ["firstSeen", "lastVerified"]) {
          const evidence = place[key] as Record<string, unknown>;
          evidence.source = "Unknown source";
          evidence.license = "proprietary";
          evidence.attribution = "none";
        }
      });

      await expect(importBackup(target, malformed, "replace", LATER)).rejects.toThrow(
        /source|licen[cs]e|attribution|evidence/i,
      );
      expect(await target.listPlaces()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe("Phase 2 backup merge LWW and final graph", () => {
  it("ignores an older list tombstone instead of falsely rejecting a newer live aggregate", async () => {
    const repo = freshRepo("phase2-older-list-tombstone");
    try {
      await seedManual(repo);
      const oldArchive = await rewriteArchive(await exportBackup(repo, NOW), (data) => {
        const list = row(data, "lists", (value) => value.id === "list-1");
        list.deleted = true;
        list.updatedAt = NOW;
      });
      const current = await repo.getList("list-1");
      if (!current) throw new Error("list fixture is missing");
      await repo.updateList({ ...current, name: "Newer live list", updatedAt: LATER });

      await expect(importBackup(repo, oldArchive, "merge", LATER)).resolves.toBeDefined();
      expect(await repo.getList("list-1")).toMatchObject({
        name: "Newer live list",
        deleted: undefined,
      });
      expect(await repo.listPlaces()).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });

  it("rejects a newer place tombstone that would leave a live block targeting a deleted place", async () => {
    const repo = freshRepo("phase2-place-tombstone-dangling-block");
    try {
      const placeId = await seedManual(repo);
      const malformed = await rewriteArchive(await exportBackup(repo, NOW), (data) => {
        const place = row(data, "places", (value) => value.id === placeId);
        place.deleted = true;
        place.updatedAt = LATER;
      });

      await expect(importBackup(repo, malformed, "merge", LATER)).rejects.toThrow(
        /block|place|graph|membership/i,
      );
      expect(await repo.getPlace(placeId)).toBeDefined();
      expect(await repo.getListBlocks("list-1")).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });

  it("rejects a merge containing a live standalone note whose target is absent", async () => {
    const source = freshRepo("phase2-merge-note-target-source");
    const target = freshRepo("phase2-merge-note-target-target");
    try {
      const placeId = await seedManual(source);
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId },
        body: "Body",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await source.createNote(note);
      const malformed = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const noteRow = row(data, "notes", (value) => value.id === note.id);
        noteRow.target = { kind: "place", placeId: "missing-place" };
        noteRow.targetKey = "place:missing-place";
      });

      await expect(importBackup(target, malformed, "merge", LATER)).rejects.toThrow(
        /note|target|place|graph/i,
      );
      expect(await target.listPlaces()).toEqual([]);
      expect(await target.db.notes.count()).toBe(0);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a merge containing a live tag assignment whose place is absent", async () => {
    const source = freshRepo("phase2-merge-assignment-place-source");
    const target = freshRepo("phase2-merge-assignment-place-target");
    try {
      const placeId = await seedManual(source);
      await source.assignTag(placeId, "coffee", NOW);
      const malformed = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        row(data, "tagAssignments", () => true).placeId = "missing-place";
      });

      await expect(importBackup(target, malformed, "merge", LATER)).rejects.toThrow(
        /tag assignment|place|graph/i,
      );
      expect(await target.db.tagAssignments.count()).toBe(0);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("never leaves two live attachment edges for the same block and note after merge", async () => {
    const repo = freshRepo("phase2-merge-attachment-pair");
    try {
      const placeId = await seedManual(repo);
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId },
        body: "Body",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      // Attachments join notes to POST place blocks (2026-07-19 pivot).
      await repo.createPost({
        id: "post-1",
        title: "list-1",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const block = await repo.embedPlaceInPost("post-1", placeId, NOW);
      await repo.attachNoteToPostBlock(block.id, note.id, NOW);
      const duplicateArchive = await rewriteArchive(await exportBackup(repo, NOW), (data) => {
        const attachment = row(data, "blockNoteAttachments", () => true);
        attachment.id = "different-edge-id";
        attachment.updatedAt = LATER;
      });

      await importBackup(repo, duplicateArchive, "merge", LATER).catch(() => undefined);

      expect(
        (await repo.db.blockNoteAttachments.toArray()).filter(
          (edge) => !edge.deleted && edge.blockId === block.id && edge.noteId === note.id,
        ),
      ).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });
});
