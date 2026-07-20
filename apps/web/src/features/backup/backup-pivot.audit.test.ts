/**
 * Replace-mode graph validations added by the 2026-07-19 lists-and-posts pivot
 * (spec/src/posts.md, spec/src/data-model.md, spec/src/storage-sync.md):
 * unique live markers, membership-only lists, member-only post embeds,
 * assignment-backed tag selections, and place/post-only note targets.
 */
import { markerAt, type ResolvedPoi } from "@placemarks/domain";
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

function poi(id: string): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name: `Place ${id}`,
    category: "cafe",
    lat: 38.7,
    lng: -9.1,
    identityTags: { name: `Place ${id}`, amenity: "cafe" },
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

let markerCounter = 0;

async function seedList(repo: DexieRepository, listId: string, osmId: string): Promise<string> {
  await repo.createList({
    id: listId,
    name: listId,
    marker: markerAt(markerCounter++),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return (await repo.addToList(listId, { kind: "poi", poi: poi(osmId) }, NOW)).place.id;
}

function rowWith(data: MutableData, table: string, predicate: (row: MutableRow) => boolean) {
  const row = data[table]?.find(predicate);
  if (!row) throw new Error(`${table} fixture missing`);
  return row;
}

describe("Pivot replace-mode graph validation", () => {
  it("rejects two live lists sharing one marker — markers are unique pairs", async () => {
    const source = freshRepo("pivot-duplicate-marker-source");
    const target = freshRepo("pivot-duplicate-marker-target");
    try {
      // Lists may be empty; only the markers are under test.
      await source.createList({
        id: "list-a",
        name: "A",
        marker: markerAt(markerCounter++),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await source.createList({
        id: "list-b",
        name: "B",
        marker: markerAt(markerCounter++),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const first = rowWith(data, "lists", (row) => row.id === "list-a");
        const second = rowWith(data, "lists", (row) => row.id === "list-b");
        second.marker = first.marker;
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /marker.*unique|share the marker/i,
      );
      expect(await target.listLists()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a live section list block — lists carry membership only", async () => {
    const source = freshRepo("pivot-section-list-block-source");
    const target = freshRepo("pivot-section-list-block-target");
    try {
      await seedList(source, "list-1", "101");
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        data.listBlocks?.push({
          id: "legacy-section",
          listId: "list-1",
          rank: "zz",
          kind: "section",
          refId: "ghost-note",
          content: { type: "section", noteId: "ghost-note" },
          createdAt: NOW,
          updatedAt: NOW,
        });
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /place membership|section/i,
      );
      expect(await target.listLists()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a post block embedding a place that is not a member of the post's list", async () => {
    const source = freshRepo("pivot-nonmember-embed-source");
    const target = freshRepo("pivot-nonmember-embed-target");
    try {
      const placeA = await seedList(source, "list-a", "101");
      const placeB = await seedList(source, "list-b", "202");
      await source.createPost({
        id: "post-a",
        title: "list-a",
        listId: "list-a",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await source.embedPlaceInPost("post-a", placeA, NOW);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const embed = rowWith(data, "postBlocks", (row) => row.kind === "place");
        embed.refId = placeB;
        embed.content = { type: "place", placeId: placeB };
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /not a member/i,
      );
      expect(await target.listPlaces()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a tag selection whose tag has no live assignment on the embed's place", async () => {
    const source = freshRepo("pivot-unbacked-selection-source");
    const target = freshRepo("pivot-unbacked-selection-target");
    try {
      const placeA = await seedList(source, "list-a", "101");
      await source.assignTag(placeA, "coffee", NOW);
      const coffee = (await source.listTags()).find((tag) => tag.name === "coffee");
      if (!coffee) throw new Error("tag fixture missing");
      await source.createPost({
        id: "post-a",
        title: "list-a",
        listId: "list-a",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const embed = await source.embedPlaceInPost("post-a", placeA, NOW);
      await source.selectTagForPostBlock(embed.id, coffee.id, NOW);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        // The assignment disappears; the selection must not survive it.
        data.tagAssignments = [];
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /not assigned|assignment/i,
      );
      expect(await target.listTags()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it('rejects a live note with the retired "list" target kind in post-pivot data', async () => {
    const source = freshRepo("pivot-list-note-source");
    const target = freshRepo("pivot-list-note-target");
    try {
      await seedList(source, "list-1", "101");
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        // A v3 archive claiming a list-targeted note is invalid — only a v2
        // archive may carry one, and the import pivots it onto a post.
        data.notes?.push({
          id: "legacy-list-note",
          target: { kind: "list", listId: "list-1" },
          targetKey: "list:list-1",
          body: "Legacy list prose",
          mediaIds: [],
          shareable: false,
          createdAt: NOW,
          updatedAt: NOW,
        });
      });

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /targets no live row/i,
      );
      expect(await target.listPlaces()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
