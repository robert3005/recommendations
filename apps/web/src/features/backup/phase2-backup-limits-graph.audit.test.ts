import type { ResolvedPoi } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, Zip, ZipPassThrough, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return { ...actual, unzipSync: vi.fn(actual.unzipSync) };
});

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T13:00:00.000Z";
const PATHOLOGICAL_ENTRY_COUNT = 10_000;

type MutableRow = { id: string; [key: string]: unknown };
type MutableBackupData = Record<string, MutableRow[]>;
type MutableManifest = {
  checksums: Record<string, string>;
  counts: Record<string, number>;
  [key: string]: unknown;
};

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

function poi(id: string, resolvedAt = NOW): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name: `Place ${id}`,
    category: "cafe",
    lat: 38.7,
    lng: -9.1,
    identityTags: { name: `Place ${id}`, amenity: "cafe" },
    resolvedAt,
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
  mutate: (
    data: MutableBackupData,
    entries: Record<string, Uint8Array>,
    manifest: MutableManifest,
  ) => void,
  options: { syncCounts?: boolean } = {},
): Promise<Blob> {
  const entries = unzipSync(await blobBytes(backup));
  const data = JSON.parse(strFromU8(entries["data.json"] ?? new Uint8Array())) as MutableBackupData;
  const manifest = JSON.parse(
    strFromU8(entries["manifest.json"] ?? new Uint8Array()),
  ) as MutableManifest;

  mutate(data, entries, manifest);
  if (options.syncCounts !== false) {
    manifest.counts = Object.fromEntries(
      Object.entries(data).map(([table, rows]) => [table, rows.length]),
    );
  }
  const dataBytes = strToU8(JSON.stringify(data));
  entries["data.json"] = dataBytes;
  manifest.checksums["data.json"] = await sha256Hex(dataBytes);
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));

  const zipped = zipSync(entries);
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

async function archiveWithDeclaredPaddingEntries(backup: Blob): Promise<Blob> {
  const entries = unzipSync(await blobBytes(backup));
  const manifest = JSON.parse(
    strFromU8(entries["manifest.json"] ?? new Uint8Array()),
  ) as MutableManifest;
  const empty = new Uint8Array();
  const emptyChecksum = await sha256Hex(empty);
  for (let index = 0; index < PATHOLOGICAL_ENTRY_COUNT; index += 1) {
    const name = `padding/${index}.bin`;
    entries[name] = empty;
    manifest.checksums[name] = emptyChecksum;
  }
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  const zipped = zipSync(entries);
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

async function archiveWithDuplicateNamedEntries(backup: Blob): Promise<Blob> {
  const entries = unzipSync(await blobBytes(backup));
  const manifest = JSON.parse(
    strFromU8(entries["manifest.json"] ?? new Uint8Array()),
  ) as MutableManifest;
  const empty = new Uint8Array();
  manifest.checksums["padding.bin"] = await sha256Hex(empty);
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));

  const chunks: Uint8Array[] = [];
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    const stream = new Zip((error, chunk, final) => {
      if (error) {
        reject(error);
        return;
      }
      chunks.push(chunk);
      if (!final) return;
      const size = chunks.reduce((total, part) => total + part.length, 0);
      const result = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) {
        result.set(part, offset);
        offset += part.length;
      }
      resolve(result);
    });
    for (const [name, bytes] of Object.entries(entries)) {
      const file = new ZipPassThrough(name);
      stream.add(file);
      file.push(bytes, true);
    }
    for (let index = 0; index < PATHOLOGICAL_ENTRY_COUNT; index += 1) {
      const file = new ZipPassThrough("padding.bin");
      stream.add(file);
      file.push(empty, true);
    }
    stream.end();
  });
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

async function seedSimple(
  repo: DexieRepository,
  listId: string,
  osmId: string,
  at = NOW,
): Promise<string> {
  await repo.createList({ id: listId, name: listId, createdAt: at, updatedAt: at });
  return (await repo.addToList(listId, { kind: "poi", poi: poi(osmId, at) }, at)).place.id;
}

async function seedRich(repo: DexieRepository): Promise<void> {
  const placeA = await seedSimple(repo, "list-a", "101");
  await repo.assignTag(placeA, "coffee", NOW);
  await repo.createNote({
    id: "place-note",
    target: { kind: "place", placeId: placeA },
    body: "A place note",
    mediaIds: [],
    shareable: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const placeBlock = (await repo.getGuideBlocks("list-a")).find(
    ({ block }) => block.content.type === "place",
  );
  if (!placeBlock) throw new Error("place-block fixture missing");
  await repo.attachNoteToBlock(placeBlock.block.id, "place-note", NOW);
  await repo.addSectionBlock("list-a", "Section body", NOW);
  await seedSimple(repo, "list-b", "202");
}

function rowWith(data: MutableBackupData, table: string, predicate: (row: MutableRow) => boolean) {
  const row = data[table]?.find(predicate);
  if (!row) throw new Error(`${table} fixture missing`);
  return row;
}

describe("Phase 2 backup resource and manifest audit", () => {
  it("rejects an obviously oversized archive from Blob metadata before reading it", async () => {
    const target = freshRepo("phase2-archive-size-target");
    try {
      await seedSimple(target, "target-list", "900");
      const oversized = new Blob(["not a zip"]);
      let bytesRead = false;
      Object.defineProperty(oversized, "size", {
        configurable: true,
        value: Number.MAX_SAFE_INTEGER,
      });
      Object.defineProperty(oversized, "arrayBuffer", {
        configurable: true,
        value: async () => {
          bytesRead = true;
          throw new Error("oversized archive bytes were read");
        },
      });

      let rejection: unknown;
      try {
        await importBackup(target, oversized, "replace", LATER);
      } catch (error) {
        rejection = error;
      }
      expect(bytesRead).toBe(false);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/archive.*(?:large|limit|size)|too large/i);
      expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
    } finally {
      target.db.close();
    }
  });

  it("rejects a pathological archive entry count before checksum work", async () => {
    const source = freshRepo("phase2-entry-count-source");
    const target = freshRepo("phase2-entry-count-target");
    try {
      await seedSimple(target, "target-list", "900");
      const archive = await archiveWithDeclaredPaddingEntries(await exportBackup(source, NOW));

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /entry count|too many entr|entr(?:y|ies).*limit/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("counts duplicate ZIP member names toward the archive entry budget", async () => {
    const source = freshRepo("phase2-duplicate-entry-count-source");
    const target = freshRepo("phase2-duplicate-entry-count-target");
    try {
      await seedSimple(target, "target-list", "900");
      const archive = await archiveWithDuplicateNamedEntries(await exportBackup(source, NOW));

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(
        /entry count|too many entr|entr(?:y|ies).*limit/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects an effectively unbounded inflated-byte total before checksum and parse work", async () => {
    const source = freshRepo("phase2-inflated-size-source");
    const target = freshRepo("phase2-inflated-size-target");
    try {
      await seedSimple(target, "target-list", "900");
      const archive = await exportBackup(source, NOW);
      const entries = unzipSync(await blobBytes(archive));
      const dataBytes = entries["data.json"];
      if (!dataBytes) throw new Error("data fixture missing");
      // Inject the extractor result so no decompression bomb is allocated in the test.
      // A compliant importer rejects the aggregate before hashing or parsing any entry.
      Object.defineProperty(dataBytes, "byteLength", {
        configurable: true,
        value: Number.MAX_SAFE_INTEGER,
      });
      Object.defineProperty(dataBytes, "length", {
        configurable: true,
        value: Number.MAX_SAFE_INTEGER,
      });
      vi.mocked(unzipSync).mockReturnValueOnce(entries);
      const digest = vi.spyOn(crypto.subtle, "digest");
      let rejection: unknown;
      try {
        await importBackup(target, archive, "replace", LATER);
      } catch (error) {
        rejection = error;
      }
      const digestCalled = digest.mock.calls.length > 0;
      digest.mockRestore();
      expect(digestCalled).toBe(false);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(
        /inflate|decompress|expanded|uncompressed|size limit|too large/i,
      );
      expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects manifest counts that do not exactly describe data.json", async () => {
    const source = freshRepo("phase2-count-source");
    const target = freshRepo("phase2-count-target");
    try {
      await seedSimple(source, "source-list", "101");
      await seedSimple(target, "target-list", "900");
      const archive = await rewriteArchive(
        await exportBackup(source, NOW),
        (_data, _entries, manifest) => {
          manifest.counts.places = 99;
        },
        { syncCounts: false },
      );

      await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow(/count/i);
      expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

const graphCases: Array<{
  name: string;
  mutate: (data: MutableBackupData) => void;
}> = [
  {
    name: "a live tag assignment whose tag does not exist",
    mutate(data) {
      rowWith(data, "tagAssignments", () => true).tagId = "missing-tag";
    },
  },
  {
    name: "a live tag assignment whose place does not exist",
    mutate(data) {
      rowWith(data, "tagAssignments", () => true).placeId = "missing-place";
    },
  },
  {
    name: "two live tag-assignment edges for the same place and tag",
    mutate(data) {
      const assignment = rowWith(data, "tagAssignments", () => true);
      data.tagAssignments?.push({ ...assignment, id: "duplicate-tag-assignment" });
    },
  },
  {
    name: "an unattached live note whose target does not exist",
    mutate(data) {
      const note = rowWith(data, "notes", (row) => row.id === "place-note");
      data.notes?.push({
        ...note,
        id: "dangling-private-note",
        target: { kind: "place", placeId: "missing-place" },
        targetKey: "place:missing-place",
      });
    },
  },
  {
    name: "a section note owned by a different live list",
    mutate(data) {
      const section = rowWith(data, "listBlocks", (row) => row.kind === "section");
      const note = rowWith(data, "notes", (row) => row.id === section.refId);
      note.target = { kind: "list", listId: "list-b" };
      note.targetKey = "list:list-b";
    },
  },
  {
    name: "an attached note targeting a different live place",
    mutate(data) {
      const attachment = rowWith(data, "blockNoteAttachments", () => true);
      const note = rowWith(data, "notes", (row) => row.id === attachment.noteId);
      const otherPlace = rowWith(
        data,
        "places",
        (row) => (row.currentOsmRef as { id?: string } | undefined)?.id === "202",
      );
      note.target = { kind: "place", placeId: otherPlace.id };
      note.targetKey = `place:${otherPlace.id}`;
    },
  },
  {
    name: "two live memberships for the same place in one list",
    mutate(data) {
      const block = rowWith(
        data,
        "listBlocks",
        (row) => row.listId === "list-a" && row.kind === "place",
      );
      data.listBlocks?.push({ ...block, id: "duplicate-place-membership", rank: "zzzz" });
    },
  },
  {
    name: "two live attachment edges for the same block and note",
    mutate(data) {
      const attachment = rowWith(data, "blockNoteAttachments", () => true);
      data.blockNoteAttachments?.push({
        ...attachment,
        id: "duplicate-note-attachment",
        rank: "zzzz",
      });
    },
  },
  {
    name: "a live place block whose list does not exist",
    mutate(data) {
      const block = rowWith(
        data,
        "listBlocks",
        (row) => row.listId === "list-a" && row.kind === "place",
      );
      data.listBlocks?.push({
        ...block,
        id: "missing-list-membership",
        listId: "missing-list",
        rank: "zzzz",
      });
    },
  },
];

describe("Phase 2 backup full-graph audit", () => {
  for (const graphCase of graphCases) {
    it(`rejects ${graphCase.name} before replace writes`, async () => {
      const source = freshRepo("phase2-full-graph-source");
      const target = freshRepo("phase2-full-graph-target");
      try {
        await seedRich(source);
        await seedSimple(target, "target-list", "900");
        const archive = await rewriteArchive(await exportBackup(source, NOW), graphCase.mutate);

        await expect(importBackup(target, archive, "replace", LATER)).rejects.toThrow();
        expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
      } finally {
        source.db.close();
        target.db.close();
      }
    });
  }
});

describe("Phase 2 backup merge final-state and identity audit", () => {
  it("rejects a merge whose final graph would contain a live orphan place", async () => {
    const source = freshRepo("phase2-merge-orphan-source");
    const target = freshRepo("phase2-merge-orphan-target");
    try {
      await seedSimple(source, "source-list", "101");
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        data.listBlocks = [];
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(
        /membership|orphan|graph/i,
      );
      expect(await target.listPlaces()).toEqual([]);
      expect(await target.listLists()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a merge whose rewritten final graph has a tag assignment with no live tag", async () => {
    const source = freshRepo("phase2-merge-dangling-tag-source");
    const target = freshRepo("phase2-merge-dangling-tag-target");
    try {
      const incomingId = await seedSimple(source, "source-list", "101");
      await source.assignTag(incomingId, "coffee", NOW);
      await seedSimple(target, "target-list", "101");
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        data.tags = [];
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(/tag|graph/i);
      expect((await target.listLists()).map((list) => list.id)).toEqual(["target-list"]);
      expect(await target.listTags()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a merge whose final attachment joins a block and note about different places", async () => {
    const source = freshRepo("phase2-merge-attachment-source");
    const target = freshRepo("phase2-merge-attachment-target");
    try {
      await seedRich(source);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const attachment = rowWith(data, "blockNoteAttachments", () => true);
        const note = rowWith(data, "notes", (row) => row.id === attachment.noteId);
        const otherPlace = rowWith(
          data,
          "places",
          (row) => (row.currentOsmRef as { id?: string } | undefined)?.id === "202",
        );
        note.target = { kind: "place", placeId: otherPlace.id };
        note.targetKey = `place:${otherPlace.id}`;
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(
        /attachment|note|graph/i,
      );
      expect(await target.listPlaces()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("applies LWW tombstones before deciding whether the merged graph has membership", async () => {
    const target = freshRepo("phase2-merge-membership-lww-target");
    try {
      const placeId = await seedSimple(target, "target-list", "101", NOW);
      const archive = await rewriteArchive(await exportBackup(target, NOW), (data) => {
        const membership = rowWith(
          data,
          "listBlocks",
          (row) => row.listId === "target-list" && row.refId === placeId,
        );
        membership.deleted = true;
        membership.updatedAt = LATER;
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(
        /membership|orphan|graph/i,
      );
      expect(await target.listIdsForPlace(placeId)).toEqual(["target-list"]);
    } finally {
      target.db.close();
    }
  });

  it("does not let forged refKeys bypass the same-PlaceId identity collision guard", async () => {
    const source = freshRepo("phase2-forged-refkeys-source");
    const target = freshRepo("phase2-forged-refkeys-target");
    try {
      const incomingId = await seedSimple(source, "source-list", "202", LATER);
      const retainedId = await seedSimple(target, "target-list", "101", NOW);
      const archive = await rewriteArchive(await exportBackup(source, LATER), (data) => {
        const place = rowWith(data, "places", (row) => row.id === incomingId);
        place.id = retainedId;
        place.refKeys = ["node/101"];
        const block = rowWith(data, "listBlocks", (row) => row.refId === incomingId);
        block.refId = retainedId;
        block.content = { type: "place", placeId: retainedId };
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(
        /collision|identity|PlaceId/i,
      );
      expect((await target.getPlace(retainedId))?.currentOsmRef).toEqual({
        type: "node",
        id: "101",
      });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("does not let a newer manual place overwrite an OSM place with the same arbitrary UUID", async () => {
    const source = freshRepo("phase2-manual-id-collision-source");
    const target = freshRepo("phase2-manual-id-collision-target");
    try {
      await source.createList({
        id: "source-list",
        name: "source-list",
        createdAt: LATER,
        updatedAt: LATER,
      });
      const incomingId = (
        await source.addToList(
          "source-list",
          { kind: "manual", facts: { name: "Different manual pin", lat: 40, lng: -8 } },
          LATER,
        )
      ).place.id;
      const retainedId = await seedSimple(target, "target-list", "101", NOW);
      const archive = await rewriteArchive(await exportBackup(source, LATER), (data) => {
        const place = rowWith(data, "places", (row) => row.id === incomingId);
        place.id = retainedId;
        const block = rowWith(data, "listBlocks", (row) => row.refId === incomingId);
        block.refId = retainedId;
        block.content = { type: "place", placeId: retainedId };
      });

      await expect(importBackup(target, archive, "merge", LATER)).rejects.toThrow(
        /collision|identity|PlaceId/i,
      );
      expect((await target.getPlace(retainedId))?.origin).toBe("osm");
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("coalesces an exact OSM ref using canonical evidence when incoming refKeys are empty", async () => {
    const source = freshRepo("phase2-empty-refkeys-source");
    const target = freshRepo("phase2-empty-refkeys-target");
    try {
      await seedSimple(source, "source-list", "101", NOW);
      const retainedId = await seedSimple(target, "target-list", "101", NOW);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        rowWith(data, "places", () => true).refKeys = [];
      });

      await importBackup(target, archive, "merge", LATER);

      expect(await target.listPlaces()).toHaveLength(1);
      expect((await target.listIdsForPlace(retainedId)).sort()).toEqual([
        "source-list",
        "target-list",
      ]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("coalesces exact OSM references duplicated between two incoming PlaceIds", async () => {
    const source = freshRepo("phase2-incoming-ref-duplicate-source");
    const target = freshRepo("phase2-incoming-ref-duplicate-target");
    try {
      await seedSimple(source, "list-a", "101", NOW);
      await seedSimple(source, "list-b", "202", NOW);
      const archive = await rewriteArchive(await exportBackup(source, NOW), (data) => {
        const second = rowWith(
          data,
          "places",
          (row) => (row.currentOsmRef as { id?: string } | undefined)?.id === "202",
        );
        second.currentOsmRef = { type: "node", id: "101" };
        second.refKeys = ["node/101"];
      });

      await importBackup(target, archive, "merge", LATER);

      const places = await target.listPlaces();
      expect(places).toHaveLength(1);
      expect((await target.listIdsForPlace(places[0]?.place.id ?? "")).sort()).toEqual([
        "list-a",
        "list-b",
      ]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
