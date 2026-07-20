import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const LEGACY_SCHEMA = {
  places: "id, resolutionState, updatedAt, *refKeys",
  savedPlaces: "id, placeId, updatedAt",
  tags: "id, nameNorm, updatedAt",
  tagAssignments: "id, savedPlaceId, tagId, [savedPlaceId+tagId], updatedAt",
  notes: "id, targetKey, updatedAt",
  mediaAssets: "id, updatedAt",
  mediaBlobs: "id",
  lists: "id, updatedAt",
  listBlocks: "id, listId, kind, refId, updatedAt",
  blockNoteAttachments: "id, blockId, noteId, [blockId+noteId], updatedAt",
};

describe("membership migration", () => {
  it("preserves a formerly saved place that did not belong to a list", async () => {
    const dbName = `membership-migration-${crypto.randomUUID()}`;
    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_SCHEMA);

    await legacy.table("places").put({
      id: "place-1",
      origin: "osm",
      currentOsmRef: { type: "node", id: "101" },
      currentOsmLinkedAt: "2026-07-17T00:00:00.000Z",
      osmRefHistory: [],
      resolutionState: "resolved",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      refKeys: ["node/101"],
    });
    await legacy.table("savedPlaces").put({
      id: "save-1",
      placeId: "place-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    legacy.close();

    const repo = new DexieRepository(dbName);
    try {
      await repo.db.open();

      expect(await repo.getPlace("place-1")).toBeDefined();
      expect(await repo.listIdsForPlace("place-1")).not.toHaveLength(0);
      expect((await repo.listPlaces()).map(({ place }) => place.id)).toContain("place-1");
    } finally {
      repo.db.close();
      await Dexie.delete(dbName);
    }
  });
});

/** Cumulative schema as of v6 — the on-disk shape the v7 pivot upgrades. */
const V6_SCHEMA = {
  places: "id, resolutionState, updatedAt, *refKeys",
  tags: "id, nameNorm, updatedAt",
  tagAssignments: "id, placeId, tagId, [placeId+tagId], updatedAt",
  notes: "id, targetKey, updatedAt",
  mediaAssets: "id, updatedAt",
  mediaBlobs: "id",
  lists: "id, updatedAt",
  listBlocks: "id, listId, kind, refId, updatedAt",
  blockNoteAttachments: "id, blockId, noteId, [blockId+noteId], updatedAt",
  importBatches: "id, status, startedAt",
  importItems: "id, batchId, status",
  importSources: "sourceKey",
  publications: "id, status, updatedAt",
  credentials: "id",
  publicationOutbox: "id, publicationId, createdAt",
};

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-02T00:00:00.000Z";

function v6Place(id: string, name: string) {
  return {
    id,
    origin: "manual",
    osmRefHistory: [],
    manual: { name, lat: 38.7139, lng: -9.1394 },
    resolutionState: "unlinked",
    createdAt: T0,
    updatedAt: T0,
    refKeys: [],
  };
}

describe("v7 lists-and-posts pivot migration (spec/src/posts.md §Migration from the guide layer)", () => {
  it("assigns unique markers, spawns a post from editorial content with derived ids, and leaves plain lists alone", async () => {
    const dbName = `pivot-migration-${crypto.randomUUID()}`;
    const legacy = new Dexie(dbName);
    legacy.version(6).stores(V6_SCHEMA);

    // An editorial list: a section between place blocks, a list-targeted note,
    // an attachment on a place block, and a hosted publication of the list.
    await legacy.table("lists").bulkPut([
      { id: "list-editorial", name: "City guide", color: "#2563eb", createdAt: T0, updatedAt: T0 },
      { id: "list-plain", name: "Plain places", color: "#2563eb", createdAt: T1, updatedAt: T1 },
    ]);
    await legacy.table("places").bulkPut([v6Place("place-1", "Café"), v6Place("place-2", "Bar")]);
    await legacy.table("listBlocks").bulkPut([
      {
        id: "block-section",
        listId: "list-editorial",
        rank: "a0",
        kind: "section",
        refId: "note-section",
        content: { type: "section", noteId: "note-section" },
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: "block-place",
        listId: "list-editorial",
        rank: "a1",
        kind: "place",
        refId: "place-1",
        content: { type: "place", placeId: "place-1" },
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: "block-plain",
        listId: "list-plain",
        rank: "a0",
        kind: "place",
        refId: "place-2",
        content: { type: "place", placeId: "place-2" },
        createdAt: T1,
        updatedAt: T1,
      },
    ]);
    await legacy.table("notes").bulkPut([
      {
        id: "note-section",
        target: { kind: "list", listId: "list-editorial" },
        targetKey: "list:list-editorial",
        body: "Intro",
        mediaIds: [],
        shareable: false,
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: "note-place",
        target: { kind: "place", placeId: "place-1" },
        targetKey: "place:place-1",
        body: "Order the bica",
        mediaIds: [],
        shareable: true,
        createdAt: T0,
        updatedAt: T0,
      },
    ]);
    await legacy.table("blockNoteAttachments").put({
      id: "attachment-1",
      blockId: "block-place",
      noteId: "note-place",
      rank: "a0",
      createdAt: T0,
      updatedAt: T0,
    });
    await legacy.table("publications").bulkPut([
      {
        id: "publication-editorial",
        target: { kind: "list", id: "list-editorial" },
        mode: "hosted",
        slug: "city-guide",
        status: "published",
        localRevision: "r1",
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: "publication-plain",
        target: { kind: "list", id: "list-plain" },
        mode: "hosted",
        slug: "plain-places",
        status: "published",
        localRevision: "r1",
        createdAt: T1,
        updatedAt: T1,
      },
    ]);
    legacy.close();

    const repo = new DexieRepository(dbName);
    try {
      await repo.db.open();

      // Markers are assigned uniquely, keeping each legacy colour: same colour
      // twice → same colour, different icons (assignment order = creation time).
      const editorial = await repo.db.lists.get("list-editorial");
      const plain = await repo.db.lists.get("list-plain");
      expect(editorial?.marker).toEqual({ color: "#2563eb", icon: "circle" });
      expect(plain?.marker).toEqual({ color: "#2563eb", icon: "diamond" });
      expect((editorial as { color?: string } | undefined)?.color).toBeUndefined();
      expect((editorial as { icon?: string } | undefined)?.icon).toBeUndefined();

      // The editorial list spawned a same-titled post under DERIVED ids so a
      // re-run (e.g. a restored pre-pivot backup) converges instead of duplicating.
      const posts = await repo.db.posts.toArray();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        id: "list-editorial:post",
        title: "City guide",
        listId: "list-editorial",
      });
      const postBlocks = (await repo.db.postBlocks.toArray()).sort((a, b) =>
        a.rank < b.rank ? -1 : 1,
      );
      expect(
        postBlocks.map(({ id, postId, rank, kind, refId, content }) => ({
          id,
          postId,
          rank,
          kind,
          refId,
          content,
        })),
      ).toEqual([
        {
          id: "block-section:pb",
          postId: "list-editorial:post",
          rank: "a0",
          kind: "section",
          refId: "note-section",
          content: { type: "section", noteId: "note-section" },
        },
        {
          id: "block-place:pb",
          postId: "list-editorial:post",
          rank: "a1",
          kind: "place",
          refId: "place-1",
          content: { type: "place", placeId: "place-1" },
        },
      ]);

      // The list keeps only its place blocks; the section block tombstoned.
      await expect(repo.db.listBlocks.get("block-section")).resolves.toMatchObject({
        deleted: true,
      });
      expect((await repo.db.listBlocks.get("block-place"))?.deleted).not.toBe(true);

      // The list note retargeted to the post; the attachment moved to the
      // post's place block; the place note itself is untouched.
      await expect(repo.db.notes.get("note-section")).resolves.toMatchObject({
        target: { kind: "post", postId: "list-editorial:post" },
        targetKey: "post:list-editorial:post",
      });
      await expect(repo.db.notes.get("note-place")).resolves.toMatchObject({
        targetKey: "place:place-1",
      });
      await expect(repo.db.blockNoteAttachments.get("attachment-1")).resolves.toMatchObject({
        blockId: "block-place:pb",
      });

      // The editorial list's publication follows the content to the post but
      // keeps serving from /s/lists; the plain list's publication is untouched.
      await expect(repo.db.publications.get("publication-editorial")).resolves.toMatchObject({
        target: { kind: "post", id: "list-editorial:post" },
        channel: "lists",
        slug: "city-guide",
      });
      const plainPublication = await repo.db.publications.get("publication-plain");
      expect(plainPublication?.target).toEqual({ kind: "list", id: "list-plain" });
      expect(plainPublication?.channel).toBeUndefined();

      // A list with no editorial content spawns no post and keeps its blocks.
      expect((await repo.db.listBlocks.get("block-plain"))?.deleted).not.toBe(true);
      expect(await repo.listPostsForList("list-plain")).toHaveLength(0);

      // The migrated graph is readable through the repository contract.
      const views = await repo.getPostBlocks("list-editorial:post");
      expect(views.map((v) => v.block.content.type)).toEqual(["section", "place"]);
      expect(views[0]?.sectionNote?.body).toBe("Intro");
      expect(views[1]?.place?.id).toBe("place-1");
      expect(views[1]?.attachments?.map(({ note }) => note.id)).toEqual(["note-place"]);
    } finally {
      repo.db.close();
      await Dexie.delete(dbName);
    }
  });
});
