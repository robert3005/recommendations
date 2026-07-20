/**
 * Authoritative bottom-up teardown contracts from spec/src/posts.md and
 * spec/src/data-model.md. Written content must never disappear as the side
 * effect of removing a membership or list.
 */
import { markerAt, TeardownRefusedError } from "@placemarks/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T01:00:00.000Z";

let repo: DexieRepository;

beforeEach(() => {
  repo = new DexieRepository(`bottom-up-teardown-${crypto.randomUUID()}`);
});

async function createList(id: string, markerIndex: number): Promise<void> {
  await repo.createList({
    id,
    name: id,
    marker: markerAt(markerIndex),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function addPlace(listId: string, name = "A place") {
  return repo.addToList(listId, { kind: "manual", facts: { name, lat: 51.5, lng: -0.12 } }, NOW);
}

describe("Phase 6/7 bottom-up teardown", () => {
  it("refuses the final membership while a note exists and commits nothing", async () => {
    await createList("list-1", 0);
    const view = await addPlace("list-1");
    await repo.createNote({
      id: "note-1",
      target: { kind: "place", placeId: view.place.id },
      title: "Keep me",
      body: "Authored prose",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [membership] = await repo.getListBlocks("list-1");
    if (!membership) throw new Error("membership fixture missing");

    const refusal = repo.removeBlock(membership.block.id, LATER);
    await expect(refusal).rejects.toBeInstanceOf(TeardownRefusedError);
    await expect(refusal).rejects.toMatchObject({
      blockers: { notes: [{ noteId: "note-1", title: "Keep me" }] },
    });

    expect(await repo.getPlace(view.place.id)).toBeDefined();
    expect(await repo.getListBlocks("list-1")).toHaveLength(1);
    expect(await repo.listNotesForPlace(view.place.id)).toHaveLength(1);

    await repo.deleteNote("note-1", LATER);
    await repo.removeBlock(membership.block.id, LATER);
    expect(await repo.getPlace(view.place.id)).toBeUndefined();
  });

  it("blocks the embedding list, but notes do not block a non-final membership", async () => {
    await createList("list-1", 0);
    await createList("list-2", 1);
    const view = await addPlace("list-1");
    await repo.addToList("list-2", { kind: "existing", placeId: view.place.id }, NOW);
    await repo.createNote({
      id: "note-1",
      target: { kind: "place", placeId: view.place.id },
      body: "The place survives in list-2",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.createPost({
      id: "post-1",
      title: "Post one",
      listId: "list-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const embed = await repo.embedPlaceInPost("post-1", view.place.id, NOW);
    const [membership] = await repo.getListBlocks("list-1");
    if (!membership) throw new Error("membership fixture missing");

    await expect(repo.removeBlock(membership.block.id, LATER)).rejects.toMatchObject({
      blockers: { embeds: [{ postId: "post-1", blockId: embed.id }], notes: [] },
    });

    await repo.removePostBlock(embed.id, LATER);
    await repo.removeBlock(membership.block.id, LATER);
    expect(await repo.getPlace(view.place.id)).toBeDefined();
    expect(await repo.listIdsForPlace(view.place.id)).toEqual(["list-2"]);
    expect(await repo.listNotesForPlace(view.place.id)).toHaveLength(1);
  });

  it("deletes a list only after places and posts have been explicitly removed", async () => {
    await createList("list-1", 0);
    await addPlace("list-1");
    await repo.createPost({
      id: "post-1",
      title: "Post one",
      listId: "list-1",
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(repo.deleteList("list-1", LATER)).rejects.toMatchObject({
      blockers: {
        members: [expect.any(String)],
        posts: [{ postId: "post-1", title: "Post one" }],
      },
    });

    await repo.removeAllPlaces("list-1", LATER);
    await expect(repo.deleteList("list-1", LATER)).rejects.toMatchObject({
      blockers: { members: [], posts: [{ postId: "post-1" }] },
    });
    await repo.deletePost("post-1", LATER);
    await repo.deleteList("list-1", LATER);

    expect(await repo.getList("list-1")).toBeUndefined();
    expect(await repo.getPost("post-1")).toBeUndefined();
  });
});
