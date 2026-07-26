/**
 * A successful backup export must never produce an archive its own restore
 * refuses — and old (pre-pivot, schemaVersion 2) archives must keep restoring
 * into the post-pivot model (spec/src/posts.md §Migration from the guide layer).
 */
import { markerKey } from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, INFLATED_BYTE_LIMIT, importBackup } from "./backup";

const NOW = "2026-07-19T13:00:00.000Z";

describe("Phase 6 backup export/import resource compatibility", () => {
  it("either refuses an oversized export up front or emits a restorable archive", async () => {
    const target = new DexieRepository(`phase6-large-export-target-${crypto.randomUUID()}`);
    const mediaBytes = new Uint8Array(INFLATED_BYTE_LIMIT + 1);
    const emptyTable = { toArray: async () => [] };
    const mediaAssets = [
      {
        id: "large-media",
        mime: "image/webp",
        localBlobKey: "large-media.webp",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    // Keep the large fixture out of IndexedDB/jsdom's Blob bridge: export
    // depends only on this repository-shaped read boundary.
    const source = {
      db: {
        places: emptyTable,
        tags: emptyTable,
        tagAssignments: emptyTable,
        notes: emptyTable,
        mediaAssets: { toArray: async () => mediaAssets },
        lists: emptyTable,
        listBlocks: emptyTable,
        posts: emptyTable,
        postBlocks: emptyTable,
        blockNoteAttachments: emptyTable,
        blockTagSelections: emptyTable,
        mediaBlobs: {
          get: async () => ({
            blob: {
              arrayBuffer: async () => mediaBytes.buffer as ArrayBuffer,
            } as Blob,
          }),
        },
      },
    } as unknown as DexieRepository;
    try {
      let archive: Blob | undefined;
      try {
        archive = await exportBackup(source, NOW);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/size|large|limit/i);
        return;
      }

      await expect(importBackup(target, archive, "replace", NOW)).resolves.toMatchObject({
        mode: "replace",
      });
    } finally {
      target.db.close();
    }
  }, 30_000);

  it("counts manifest.json when export data otherwise lands exactly on the inflated limit", async () => {
    const target = new DexieRepository(`phase6-manifest-boundary-target-${crypto.randomUUID()}`);
    const emptyTable = { toArray: async () => [] };
    const mediaAssets = [
      {
        id: "boundary-media",
        mime: "image/webp",
        localBlobKey: "boundary-media.webp",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    // Match exportBackup's serialized key order exactly, then fill the media
    // member so data.json + media reaches the cap before manifest.json exists.
    const dataShape = {
      places: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      mediaAssets,
      lists: [],
      listBlocks: [],
      posts: [],
      postBlocks: [],
      blockNoteAttachments: [],
      blockTagSelections: [],
    };
    const dataBytes = new TextEncoder().encode(JSON.stringify(dataShape)).byteLength;
    const mediaBytes = new Uint8Array(INFLATED_BYTE_LIMIT - dataBytes);
    const source = {
      db: {
        places: emptyTable,
        tags: emptyTable,
        tagAssignments: emptyTable,
        notes: emptyTable,
        mediaAssets: { toArray: async () => mediaAssets },
        lists: emptyTable,
        listBlocks: emptyTable,
        posts: emptyTable,
        postBlocks: emptyTable,
        blockNoteAttachments: emptyTable,
        blockTagSelections: emptyTable,
        mediaBlobs: {
          get: async () => ({
            blob: {
              arrayBuffer: async () => mediaBytes.buffer as ArrayBuffer,
            } as Blob,
          }),
        },
      },
    } as unknown as DexieRepository;

    try {
      let archive: Blob;
      try {
        archive = await exportBackup(source, NOW);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/restore|size|large|limit/i);
        return;
      }

      // If export succeeds, its own importer must accept the complete archive,
      // including the manifest that export appended after its current size gate.
      await expect(importBackup(target, archive, "replace", NOW)).resolves.toMatchObject({
        mode: "replace",
      });
    } finally {
      target.db.close();
    }
  }, 30_000);
});

const V2_NOW = "2026-07-01T10:00:00.000Z";
const V2_LATER = "2026-07-01T11:00:00.000Z";

/**
 * A genuine pre-pivot (schemaVersion 2) archive: colour-only lists, a guide
 * carrying a section list block, a list-targeted section note, and a note
 * attachment hanging off the list's place block.
 */
function v2Data() {
  return {
    places: [
      {
        id: "place-1",
        origin: "manual",
        osmRefHistory: [],
        manual: { name: "Corner café", lat: 38.71, lng: -9.14 },
        resolutionState: "unlinked",
        createdAt: V2_NOW,
        updatedAt: V2_NOW,
      },
    ],
    tags: [],
    tagAssignments: [],
    notes: [
      {
        id: "note-section",
        target: { kind: "list", listId: "guide-list" },
        targetKey: "list:guide-list",
        title: "Morning",
        body: "Start with the espresso crawl.",
        mediaIds: [],
        shareable: false,
        createdAt: V2_NOW,
        updatedAt: V2_NOW,
      },
      {
        id: "note-place",
        target: { kind: "place", placeId: "place-1" },
        targetKey: "place:place-1",
        body: "Great espresso.",
        mediaIds: [],
        shareable: true,
        createdAt: V2_NOW,
        updatedAt: V2_NOW,
      },
    ],
    mediaAssets: [],
    lists: [
      {
        id: "guide-list",
        name: "Lisbon guide",
        color: "#dc2626",
        createdAt: V2_NOW,
        updatedAt: V2_NOW,
      },
      {
        id: "plain-list",
        name: "Plain",
        color: "#2563eb",
        createdAt: V2_LATER,
        updatedAt: V2_LATER,
      },
    ],
    listBlocks: [
      {
        id: "block-section",
        listId: "guide-list",
        rank: "a0",
        kind: "section",
        refId: "note-section",
        content: { type: "section", noteId: "note-section" },
        createdAt: V2_NOW,
        updatedAt: V2_NOW,
      },
      {
        id: "block-place",
        listId: "guide-list",
        rank: "a1",
        kind: "place",
        refId: "place-1",
        content: { type: "place", placeId: "place-1" },
        createdAt: V2_NOW,
        updatedAt: V2_NOW,
      },
    ],
    blockNoteAttachments: [
      {
        id: "att-1",
        blockId: "block-place",
        noteId: "note-place",
        rank: "a",
        createdAt: V2_NOW,
        updatedAt: V2_NOW,
      },
    ],
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function v2Archive(
  exportedAt = V2_NOW,
  mutate?: (data: ReturnType<typeof v2Data>) => void,
): Promise<Blob> {
  const data = v2Data();
  mutate?.(data);
  const dataBytes = strToU8(JSON.stringify(data));
  const manifest = {
    app: "placemarks",
    schemaVersion: 2,
    exportedAt,
    checksums: { "data.json": await sha256Hex(dataBytes) },
    counts: Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length])),
    source: { attribution: "© OpenStreetMap contributors", license: "ODbL-1.0" },
  };
  const zipped = zipSync({
    "data.json": dataBytes,
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  });
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

/** The restored guide layer, pivoted: derived post/blocks, markers, retargets. */
async function expectPivotedGuide(repo: DexieRepository): Promise<void> {
  // Lists gained unique markers preserving their legacy colours.
  expect((await repo.getList("guide-list"))?.marker).toMatchObject({ color: "#dc2626" });
  expect((await repo.getList("plain-list"))?.marker).toMatchObject({ color: "#2563eb" });
  const markers = (await repo.listLists()).map((list) => markerKey(list.marker));
  expect(new Set(markers).size).toBe(markers.length);

  // The editorial list yields its derived post with the full block sequence.
  const post = await repo.getPost("guide-list:post");
  expect(post).toMatchObject({ title: "Lisbon guide", listId: "guide-list" });
  const blocks = await repo.getPostBlocks("guide-list:post");
  expect(blocks.map((view) => view.block.id)).toEqual(["block-section:pb", "block-place:pb"]);
  expect(blocks[0]?.sectionNote?.id).toBe("note-section");
  expect(blocks[1]?.place?.id).toBe("place-1");
  // The attachment moved onto the post's place block.
  expect(blocks[1]?.attachments?.map(({ note }) => note.id)).toEqual(["note-place"]);

  // The list note retargeted to the post; the plain list spawned no post.
  await expect(repo.db.notes.get("note-section")).resolves.toMatchObject({
    target: { kind: "post", postId: "guide-list:post" },
    targetKey: "post:guide-list:post",
  });
  expect(await repo.listPostsForList("plain-list")).toEqual([]);

  // Section list blocks tombstoned — the list keeps membership only.
  await expect(repo.db.listBlocks.get("block-section")).resolves.toMatchObject({ deleted: true });
  expect((await repo.getListBlocks("guide-list")).map((view) => view.block.id)).toEqual([
    "block-place",
  ]);
}

describe("Phase 6 pre-pivot (v2) archive compatibility", () => {
  it("replace-restores a v2 archive by pivoting its guide layer onto a derived post", async () => {
    const target = new DexieRepository(`phase6-v2-replace-target-${crypto.randomUUID()}`);
    try {
      await expect(importBackup(target, await v2Archive(), "replace", NOW)).resolves.toMatchObject({
        mode: "replace",
      });
      await expectPivotedGuide(target);
    } finally {
      target.db.close();
    }
  });

  it("pivots from canonical content and targets rather than forged query indexes", async () => {
    const target = new DexieRepository(`phase6-v2-canonical-target-${crypto.randomUUID()}`);
    try {
      const archive = await v2Archive(V2_NOW, (data) => {
        const section = data.listBlocks.find((block) => block.id === "block-section");
        const place = data.listBlocks.find((block) => block.id === "block-place");
        const note = data.notes.find((row) => row.id === "note-section");
        if (!section || !place || !note) throw new Error("v2 fixture is incomplete");
        section.kind = "place";
        section.refId = "place-1";
        place.kind = "section";
        place.refId = "note-section";
        note.targetKey = "place:forged-query-index";
      });

      await importBackup(target, archive, "replace", NOW);

      await expectPivotedGuide(target);
      await expect(target.db.listBlocks.get("block-section")).resolves.toMatchObject({
        kind: "section",
        refId: "note-section",
        deleted: true,
      });
      await expect(target.db.listBlocks.get("block-place")).resolves.toMatchObject({
        kind: "place",
        refId: "place-1",
      });
    } finally {
      target.db.close();
    }
  });

  it("merge-restores a v2 archive and converges on the derived pivot ids", async () => {
    const target = new DexieRepository(`phase6-v2-merge-target-${crypto.randomUUID()}`);
    try {
      await expect(importBackup(target, await v2Archive(), "merge", NOW)).resolves.toMatchObject({
        mode: "merge",
      });
      await expectPivotedGuide(target);

      // Merging the same pre-pivot archive again converges on the SAME derived
      // ids — no duplicate posts or blocks (spec/src/posts.md §Migration).
      await expect(
        importBackup(target, await v2Archive(), "merge", "2026-07-19T14:00:00.000Z"),
      ).resolves.toMatchObject({ mode: "merge" });
      expect(await repoPostCount(target)).toEqual({ posts: 1, postBlocks: 2 });
      await expectPivotedGuide(target);
    } finally {
      target.db.close();
    }
  });

  it("uses source-row timestamps so a later export cannot overwrite edits or resurrect pivot rows", async () => {
    const target = new DexieRepository(`phase6-v2-stable-time-target-${crypto.randomUUID()}`);
    const editedAt = "2026-07-20T15:00:00.000Z";
    try {
      const archive = await v2Archive();
      await importBackup(target, archive, "merge", NOW);
      const post = await target.getPost("guide-list:post");
      if (!post) throw new Error("pivot post fixture missing");
      await target.updatePost({ ...post, title: "My later edit", updatedAt: editedAt });
      await target.removePostBlock("block-place:pb", editedAt);

      // Both the restore invocation AND a newly-created archive manifest are
      // later. The unchanged source rows still derive the same pivot timestamps,
      // so neither wall clock may roll back the real edit/tombstone.
      await importBackup(
        target,
        await v2Archive("2026-07-21T16:00:00.000Z"),
        "merge",
        "2026-07-22T16:00:00.000Z",
      );

      await expect(target.getPost("guide-list:post")).resolves.toMatchObject({
        title: "My later edit",
        updatedAt: editedAt,
      });
      await expect(target.db.postBlocks.get("block-place:pb")).resolves.toMatchObject({
        deleted: true,
        updatedAt: editedAt,
      });
    } finally {
      target.db.close();
    }
  });
});

async function repoPostCount(
  repo: DexieRepository,
): Promise<{ posts: number; postBlocks: number }> {
  const posts = (await repo.db.posts.toArray()).filter((post) => !post.deleted);
  const postBlocks = (await repo.db.postBlocks.toArray()).filter((block) => !block.deleted);
  return { posts: posts.length, postBlocks: postBlocks.length };
}
