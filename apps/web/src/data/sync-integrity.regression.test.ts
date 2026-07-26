import { createOsmPlace, markerAt, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-20T10:00:00.000Z";
const LATER = "2026-07-20T11:00:00.000Z";

function repoFor(label: string, dbName?: string): DexieRepository {
  return new DexieRepository(dbName ?? `${label}-${crypto.randomUUID()}`, {
    actorId: `${label}-actor`,
  });
}

async function seedPlace(repo: DexieRepository, listId = "list-1") {
  await repo.createList({
    id: listId,
    name: "List",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return (
    await repo.addToList(
      listId,
      { kind: "manual", facts: { name: "Pin", lat: 51.5, lng: -0.12 } },
      NOW,
    )
  ).place;
}

describe("sync clock and validation boundaries", () => {
  it("keeps a local edit newer than a future remote HLC after a repository reload", async () => {
    const dbName = `durable-hlc-${crypto.randomUUID()}`;
    const first = repoFor("durable", dbName);
    const future = "999999999999999:000000:remote-device";
    try {
      await first.createList({
        id: "list-1",
        name: "Before remote",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await first.applyRemoteChanges([
        {
          table: "lists",
          entityId: "list-1",
          actorId: "remote-device",
          hlc: future,
          row: {
            id: "list-1",
            name: "Remote",
            marker: markerAt(0),
            createdAt: NOW,
            updatedAt: LATER,
          },
        },
      ]);
    } finally {
      first.db.close();
    }

    const reopened = repoFor("durable", dbName);
    try {
      const list = await reopened.getList("list-1");
      if (!list) throw new Error("remote list missing");
      await reopened.updateList({ ...list, name: "After reload", updatedAt: LATER });
      const revision = await reopened.db.syncRevs.get("lists:list-1");
      expect(revision !== undefined && revision.hlc > future).toBe(true);
    } finally {
      reopened.db.close();
      await reopened.db.delete();
    }
  });

  it("rejects a malformed or mismatched pulled row before writing any of its page", async () => {
    const repo = repoFor("invalid-pull");
    try {
      await expect(
        repo.applyRemoteChanges([
          {
            table: "lists",
            entityId: "valid-list",
            actorId: "remote",
            hlc: "000001753006399:000000:remote",
            row: {
              id: "valid-list",
              name: "Would otherwise land",
              marker: markerAt(1),
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
          {
            table: "lists",
            entityId: "envelope-id",
            actorId: "remote",
            hlc: "000001753006400:000000:remote",
            row: {
              id: "different-row-id",
              name: "Forged",
              marker: markerAt(0),
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
        ]),
      ).rejects.toThrow();
      expect(await repo.db.lists.count()).toBe(0);
    } finally {
      repo.db.close();
    }
  });

  it("repairs a concurrent duplicate list marker without dropping either list", async () => {
    const repo = repoFor("marker-merge");
    try {
      await repo.createList({
        id: "a-list",
        name: "A",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.applyRemoteChanges([
        {
          table: "lists",
          entityId: "b-list",
          actorId: "remote",
          hlc: "999999999999999:000000:remote",
          row: {
            id: "b-list",
            name: "B",
            marker: markerAt(0),
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      ]);
      const lists = await repo.listLists();
      expect(lists).toHaveLength(2);
      expect(new Set(lists.map((list) => `${list.marker.color}/${list.marker.icon}`)).size).toBe(2);
    } finally {
      repo.db.close();
    }
  });

  it("does not let a pulled parent tombstone orphan a concurrent live post", async () => {
    const repo = repoFor("remote-teardown");
    try {
      await repo.createList({
        id: "list-1",
        name: "List",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createPost({
        id: "post-1",
        title: "Concurrent article",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const listRow = await repo.db.lists.get("list-1");
      if (!listRow) throw new Error("list missing");
      await repo.applyRemoteChanges([
        {
          table: "lists",
          entityId: listRow.id,
          actorId: "remote",
          hlc: "999999999999999:000000:remote",
          row: { ...listRow, deleted: true },
        },
      ]);

      expect(await repo.getList("list-1")).toBeDefined();
      expect(await repo.getPost("post-1")).toMatchObject({ title: "Concurrent article" });
      expect((await repo.db.mutationOutbox.toArray()).some((job) => job.table === "lists")).toBe(
        true,
      );
    } finally {
      repo.db.close();
    }
  });

  it("coalesces concurrent PlaceIds for one exact OSM element and retargets memberships", async () => {
    const repo = repoFor("remote-place-dedup");
    const poi: ResolvedPoi = {
      osmRef: { type: "node", id: "101" },
      name: "Same café",
      category: "cafe",
      lat: 38.7,
      lng: -9.1,
      identityTags: { amenity: "cafe", name: "Same café" },
      resolvedAt: NOW,
    };
    try {
      await repo.createList({
        id: "list-1",
        name: "One",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createList({
        id: "list-2",
        name: "Two",
        marker: markerAt(1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.addToList("list-1", { kind: "poi", poi }, NOW);
      const remotePlace = createOsmPlace("remote-place", poi, NOW);
      await repo.applyRemoteChanges([
        {
          table: "places",
          entityId: remotePlace.id,
          actorId: "remote",
          hlc: "999999999999998:000000:remote",
          row: remotePlace as unknown as Record<string, unknown>,
        },
        {
          table: "listBlocks",
          entityId: "remote-membership",
          actorId: "remote",
          hlc: "999999999999999:000000:remote",
          row: {
            id: "remote-membership",
            listId: "list-2",
            rank: "a0",
            content: { type: "place", placeId: remotePlace.id },
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      ]);

      const places = await repo.listPlaces();
      expect(places).toHaveLength(1);
      expect((await repo.listIdsForPlace(places[0]?.place.id ?? "missing")).sort()).toEqual([
        "list-1",
        "list-2",
      ]);
      expect(await repo.db.places.get("remote-place")).toMatchObject({ deleted: true });
    } finally {
      repo.db.close();
    }
  });
});

describe("repository create/update lifecycle boundaries", () => {
  it("rejects a whole-place update that removes required display or identity evidence", async () => {
    const repo = repoFor("place-shape");
    try {
      const manual = await seedPlace(repo);
      await expect(
        repo.updatePlace({ ...manual, manual: undefined, updatedAt: LATER }),
      ).rejects.toThrow(/manual display facts/);
      expect((await repo.getPlace(manual.id))?.manual).toBeDefined();
    } finally {
      repo.db.close();
    }
  });

  it("never overwrites or resurrects list, post, or note ids through create", async () => {
    const repo = repoFor("create-lifecycle");
    try {
      const place = await seedPlace(repo);
      const list = await repo.getList("list-1");
      if (!list) throw new Error("list missing");
      await expect(repo.createList({ ...list, name: "Overwrite" })).rejects.toThrow(
        /already exists/,
      );

      const post = {
        id: "post-1",
        title: "Post",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createPost(post);
      await expect(repo.createPost({ ...post, title: "Overwrite" })).rejects.toThrow(
        /already exists/,
      );

      const note = {
        id: "note-1",
        target: { kind: "place" as const, placeId: place.id },
        body: "Body",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      await repo.deleteNote(note.id, LATER);
      await expect(repo.createNote({ ...note, body: "Resurrect" })).rejects.toThrow(
        /already exists/,
      );
    } finally {
      repo.db.close();
    }
  });

  it("keeps deletion and creation out of list/post update paths", async () => {
    const repo = repoFor("update-lifecycle");
    try {
      await seedPlace(repo);
      const list = await repo.getList("list-1");
      if (!list) throw new Error("list missing");
      await expect(repo.updateList({ ...list, deleted: true })).rejects.toThrow(/cannot delete/);
      await expect(
        repo.updateList({ ...list, id: "ghost-list", marker: markerAt(1) }),
      ).rejects.toThrow(/not found/);

      await repo.createPost({
        id: "post-1",
        title: "Post",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const post = await repo.getPost("post-1");
      if (!post) throw new Error("post missing");
      await expect(repo.updatePost({ ...post, deleted: true })).rejects.toThrow(/cannot delete/);
    } finally {
      repo.db.close();
    }
  });

  it("tombstones an old section when its note retargets and detaches a note made private", async () => {
    const repo = repoFor("note-edge-lifecycle");
    try {
      const place = await seedPlace(repo);
      await repo.createPost({
        id: "post-1",
        title: "Post",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const section = await repo.addPostSection("post-1", "Section body", NOW);
      const sectionNote = await repo.db.notes.get(
        section.content.type === "section" ? section.content.noteId : "",
      );
      if (!sectionNote) throw new Error("section note missing");
      await repo.updateNote({
        ...sectionNote,
        target: { kind: "place", placeId: place.id },
        updatedAt: LATER,
      });
      expect(await repo.db.postBlocks.get(section.id)).toMatchObject({ deleted: true });

      const embed = await repo.embedPlaceInPost("post-1", place.id, NOW);
      await repo.createNote({
        id: "attached-note",
        target: { kind: "place", placeId: place.id },
        body: "Shareable",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const attachment = await repo.attachNoteToPostBlock(embed.id, "attached-note", NOW);
      const attachedNote = await repo.db.notes.get("attached-note");
      if (!attachedNote) throw new Error("attached note missing");
      await repo.updateNote({ ...attachedNote, shareable: false, updatedAt: LATER });
      expect(await repo.db.blockNoteAttachments.get(attachment.id)).toMatchObject({
        deleted: true,
      });
    } finally {
      repo.db.close();
    }
  });
});
