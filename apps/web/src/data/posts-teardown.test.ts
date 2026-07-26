/**
 * The Post aggregate and bottom-up teardown (spec/src/posts.md,
 * spec/src/data-model.md, 2026-07-19 lists-and-posts pivot):
 *  - posts editorialise exactly one live list; embeds are members of that list;
 *  - section notes, attachments, and tag selections obey their invariants;
 *  - deletion never cascades through authored content — it is refused with the
 *    blockers named until the owner has dismantled what hangs off the target;
 *    pure edges (tag assignments, tag selections) cascade;
 *  - live list markers are unique (colour, icon) pairs.
 */
import {
  type List,
  markerAt,
  type Note,
  type Post,
  type Publication,
  type ResolvedPoi,
  TeardownRefusedError,
} from "@placemarks/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

let repo: DexieRepository;
let markerIndex = 0;

beforeEach(() => {
  markerIndex = 0;
  repo = new DexieRepository(`posts-teardown-${crypto.randomUUID()}`);
});

function poi(id: string, name = `Place ${id}`): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name,
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name, amenity: "cafe" },
    resolvedAt: NOW,
  };
}

function list(id: string, name = id): List {
  markerIndex += 1;
  return { id, name, marker: markerAt(markerIndex - 1), createdAt: NOW, updatedAt: NOW };
}

function post(id: string, listId: string, title = id): Post {
  return { id, title, listId, createdAt: NOW, updatedAt: NOW };
}

function placeNote(id: string, placeId: string, shareable = true): Note {
  return {
    id,
    target: { kind: "place", placeId },
    body: `body of ${id}`,
    shareable,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function hostedPublication(id: string, target: Publication["target"]): Publication {
  return {
    id,
    target,
    slug: id,
    credentialId: `${id}-credential`,
    status: "published",
    localRevision: `${id}-revision-1`,
    lastPublishedLocalRevision: `${id}-revision-1`,
    publishedRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function refusalOf(operation: Promise<unknown>): Promise<TeardownRefusedError> {
  const outcome = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(TeardownRefusedError);
  return outcome as TeardownRefusedError;
}

describe("post CRUD", () => {
  it("creates, lists, and updates posts bound to a live list", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));
    await repo.createPost(post("p1", "l1", "Lisbon on foot"));
    await repo.createPost(post("p2", "l2"));

    expect((await repo.listPosts()).map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect((await repo.listPostsForList("l1")).map((p) => p.id)).toEqual(["p1"]);
    expect((await repo.getPost("p1"))?.title).toBe("Lisbon on foot");

    await repo.updatePost({ ...post("p1", "l1", "Lisbon, slowly"), updatedAt: LATER });
    expect((await repo.getPost("p1"))?.title).toBe("Lisbon, slowly");
  });

  it("refuses a post for a missing or deleted list", async () => {
    await expect(repo.createPost(post("p1", "nope"))).rejects.toThrow(/list not found/);
    await repo.createList(list("l1"));
    await repo.deleteList("l1", LATER);
    await expect(repo.createPost(post("p1", "l1"))).rejects.toThrow(/list not found/);
  });

  it("keeps the post's list binding immutable and updatePost a non-creation path", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));
    await repo.createPost(post("p1", "l1"));
    await expect(repo.updatePost({ ...post("p1", "l2"), updatedAt: LATER })).rejects.toThrow(
      /immutable/,
    );
    await expect(repo.updatePost(post("ghost", "l1"))).rejects.toThrow(/not found/);
  });
});

describe("post blocks", () => {
  it("addPostSection creates a post-targeted non-shareable note with its block", async () => {
    await repo.createList(list("l1"));
    await repo.createPost(post("p1", "l1"));
    const block = await repo.addPostSection("p1", "The pastel de nata detour", NOW, "Detour");

    const views = await repo.getPostBlocks("p1");
    expect(views).toHaveLength(1);
    expect(views[0]?.block.id).toBe(block.id);
    expect(views[0]?.sectionNote).toMatchObject({
      title: "Detour",
      body: "The pastel de nata detour",
      shareable: false,
      target: { kind: "post", postId: "p1" },
    });
  });

  it("embedPlaceInPost requires membership of the post's list and forbids duplicates", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));
    const member = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    const outsider = (await repo.addToList("l2", { kind: "poi", poi: poi("102") }, NOW)).place;
    await repo.createPost(post("p1", "l1"));

    await expect(repo.embedPlaceInPost("p1", outsider.id, NOW)).rejects.toThrow(/not a member/);

    await repo.embedPlaceInPost("p1", member.id, NOW);
    await expect(repo.embedPlaceInPost("p1", member.id, LATER)).rejects.toThrow(/already embedded/);
    expect(await repo.getPostBlocks("p1")).toHaveLength(1);
  });

  it("orders post blocks by rank and moves them", async () => {
    await repo.createList(list("l1"));
    const place = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    await repo.createPost(post("p1", "l1"));
    const section = await repo.addPostSection("p1", "Intro", NOW);
    const embed = await repo.embedPlaceInPost("p1", place.id, NOW);

    expect((await repo.getPostBlocks("p1")).map((v) => v.block.id)).toEqual([section.id, embed.id]);
    await repo.movePostBlock(embed.id, section.id, LATER);
    expect((await repo.getPostBlocks("p1")).map((v) => v.block.id)).toEqual([embed.id, section.id]);
  });

  it("removePostBlock deletes a section's post-owned note but never an embed's place", async () => {
    await repo.createList(list("l1"));
    const place = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    await repo.createPost(post("p1", "l1"));
    const section = await repo.addPostSection("p1", "Intro", NOW);
    const embed = await repo.embedPlaceInPost("p1", place.id, NOW);

    await repo.removePostBlock(section.id, LATER);
    await repo.removePostBlock(embed.id, LATER);

    expect(await repo.getPostBlocks("p1")).toHaveLength(0);
    expect(
      (await repo.db.notes.toArray()).filter((n) => !n.deleted && n.target.kind === "post"),
    ).toHaveLength(0);
    // The embed's place — and its list membership — are untouched.
    expect(await repo.getPlaceView(place.id)).toBeDefined();
    expect(await repo.listIdsForPlace(place.id)).toEqual(["l1"]);
  });
});

describe("attachments and tag selections", () => {
  it("attachNoteToPostBlock requires a shareable note about the SAME place", async () => {
    await repo.createList(list("l1"));
    const a = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    const b = (await repo.addToList("l1", { kind: "poi", poi: poi("102") }, NOW)).place;
    await repo.createPost(post("p1", "l1"));
    const blockA = await repo.embedPlaceInPost("p1", a.id, NOW);
    await repo.createNote(placeNote("private-a", a.id, false));
    await repo.createNote(placeNote("shareable-b", b.id, true));
    await repo.createNote(placeNote("shareable-a", a.id, true));

    await expect(repo.attachNoteToPostBlock(blockA.id, "private-a", NOW)).rejects.toThrow(
      /shareable/,
    );
    await expect(repo.attachNoteToPostBlock(blockA.id, "shareable-b", NOW)).rejects.toThrow(
      /different place/,
    );

    const attachment = await repo.attachNoteToPostBlock(blockA.id, "shareable-a", NOW);
    // Idempotent: re-attaching the live pair returns the existing edge.
    expect((await repo.attachNoteToPostBlock(blockA.id, "shareable-a", LATER)).id).toBe(
      attachment.id,
    );
    const views = await repo.getPostBlocks("p1");
    expect(views[0]?.attachments?.map(({ note }) => note.id)).toEqual(["shareable-a"]);
  });

  it("attachments require a place block, not a section block", async () => {
    await repo.createList(list("l1"));
    const place = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    await repo.createPost(post("p1", "l1"));
    const section = await repo.addPostSection("p1", "Intro", NOW);
    await repo.createNote(placeNote("n1", place.id, true));
    await expect(repo.attachNoteToPostBlock(section.id, "n1", NOW)).rejects.toThrow(/place block/);
  });
});

describe("bottom-up teardown", () => {
  it("removeBlock is refused while a live post about that list embeds the place", async () => {
    await repo.createList(list("l1"));
    const place = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    await repo.createPost(post("p1", "l1", "The guide"));
    const embed = await repo.embedPlaceInPost("p1", place.id, NOW);
    const blockId = (await repo.getListBlocks("l1"))[0]?.block.id;
    if (!blockId) throw new Error("no membership block");

    const refusal = await refusalOf(repo.removeBlock(blockId, LATER));
    expect(refusal.blockers.embeds).toEqual([
      { placeId: place.id, postId: "p1", postTitle: "The guide", blockId: embed.id },
    ]);

    // Dismantling the embed unblocks the removal; the place then tombstones
    // with its tag assignments (pure edges cascade, content never does).
    await repo.assignTag(place.id, "coffee", NOW);
    await repo.removePostBlock(embed.id, LATER);
    await repo.removeBlock(blockId, LATER);
    expect(await repo.getPlaceView(place.id)).toBeUndefined();
    expect((await repo.db.tagAssignments.toArray()).filter((a) => !a.deleted)).toHaveLength(0);
  });

  it("removePlace is refused while the place carries live notes or any live post embeds it", async () => {
    await repo.createList(list("l1"));
    const place = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    await repo.createNote({ ...placeNote("n1", place.id, false), title: "Espresso notes" });
    await repo.createPost(post("p1", "l1", "The guide"));
    const embed = await repo.embedPlaceInPost("p1", place.id, NOW);

    const refusal = await refusalOf(repo.removePlace(place.id, LATER));
    expect(refusal.blockers.notes).toEqual([
      { placeId: place.id, noteId: "n1", title: "Espresso notes" },
    ]);
    expect(refusal.blockers.embeds).toEqual([
      { placeId: place.id, postId: "p1", postTitle: "The guide", blockId: embed.id },
    ]);
    expect(await repo.getPlaceView(place.id)).toBeDefined();

    await repo.deleteNote("n1", LATER);
    await repo.removePostBlock(embed.id, LATER);
    await repo.removePlace(place.id, LATER);
    expect(await repo.getPlaceView(place.id)).toBeUndefined();
  });

  it("deleteList is refused with named members and posts; an allowed delete revokes only the list publication", async () => {
    await repo.createList(list("l1"));
    const place = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    await repo.createPost(post("p1", "l1", "The guide"));
    const listPub = hostedPublication("pub-list", { kind: "list", id: "l1" });
    await repo.db.publications.put(listPub);

    const refusal = await refusalOf(repo.deleteList("l1", LATER));
    expect(refusal.blockers.members).toEqual([place.id]);
    expect(refusal.blockers.posts).toEqual([{ postId: "p1", title: "The guide" }]);
    expect(await repo.getList("l1")).toBeDefined();

    await repo.deletePost("p1", LATER);
    await repo.removeAllPlaces("l1", LATER);
    await repo.deleteList("l1", LATER);

    expect(await repo.getList("l1")).toBeUndefined();
    await expect(repo.db.publications.get(listPub.id)).resolves.toMatchObject({
      status: "revoking",
    });
    expect(await repo.db.publicationOutbox.toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ publicationId: listPub.id, action: "revoke" }),
      ]),
    );
  });

  it("removeAllPlaces is all-or-nothing and names every blocked place", async () => {
    await repo.createList(list("l1"));
    const noted = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    const embedded = (await repo.addToList("l1", { kind: "poi", poi: poi("102") }, NOW)).place;
    const free = (await repo.addToList("l1", { kind: "poi", poi: poi("103") }, NOW)).place;
    await repo.createNote(placeNote("n1", noted.id, false));
    await repo.createPost(post("p1", "l1", "The guide"));
    const embed = await repo.embedPlaceInPost("p1", embedded.id, NOW);

    const refusal = await refusalOf(repo.removeAllPlaces("l1", LATER));
    expect(refusal.blockers.notes.map((n) => n.placeId)).toEqual([noted.id]);
    expect(refusal.blockers.embeds.map((e) => e.placeId)).toEqual([embedded.id]);
    // All-or-nothing: nothing was removed, not even the unblocked place.
    expect(await repo.getListBlocks("l1")).toHaveLength(3);
    expect(await repo.getPlaceView(free.id)).toBeDefined();

    await repo.deleteNote("n1", LATER);
    await repo.removePostBlock(embed.id, LATER);
    await repo.removeAllPlaces("l1", LATER);
    expect(await repo.getListBlocks("l1")).toHaveLength(0);
    // Last memberships gone: the places tombstoned with their edges.
    expect(await repo.listPlaces()).toHaveLength(0);
  });

  it("deletePost takes exactly the post's own content and revokes its publication", async () => {
    await repo.createList(list("l1"));
    const place = (await repo.addToList("l1", { kind: "poi", poi: poi("101") }, NOW)).place;
    await repo.createNote(placeNote("place-note", place.id, true));
    await repo.assignTag(place.id, "coffee", NOW);
    const tag = (await repo.listTags())[0];
    if (!tag) throw new Error("no tag");
    await repo.createPost(post("p1", "l1", "The guide"));
    await repo.addPostSection("p1", "Intro", NOW);
    const embed = await repo.embedPlaceInPost("p1", place.id, NOW);
    await repo.attachNoteToPostBlock(embed.id, "place-note", NOW);
    const postPub = hostedPublication("pub-post", { kind: "post", id: "p1" });
    const listPub = hostedPublication("pub-list", { kind: "list", id: "l1" });
    await repo.db.publications.bulkPut([postPub, listPub]);

    await repo.deletePost("p1", LATER);

    // The post, its blocks, its OWN section notes, attachments, selections.
    expect(await repo.getPost("p1")).toBeUndefined();
    expect(await repo.getPostBlocks("p1")).toHaveLength(0);
    expect(
      (await repo.db.notes.toArray()).filter((n) => !n.deleted && n.target.kind === "post"),
    ).toHaveLength(0);
    expect((await repo.db.blockNoteAttachments.toArray()).filter((a) => !a.deleted)).toHaveLength(
      0,
    );
    // NEVER the list, its places, their notes, or their tag assignments.
    expect(await repo.getList("l1")).toBeDefined();
    expect(await repo.getPlaceView(place.id)).toBeDefined();
    expect(await repo.listNotesForPlace(place.id)).toHaveLength(1);
    expect((await repo.getPlaceView(place.id))?.tags).toHaveLength(1);
    // The post's hosted publication queues revocation; the list's is untouched.
    await expect(repo.db.publications.get(postPub.id)).resolves.toMatchObject({
      status: "revoking",
    });
    await expect(repo.db.publications.get(listPub.id)).resolves.toMatchObject({
      status: "published",
      localRevision: listPub.localRevision,
    });
    expect(await repo.db.publicationOutbox.toArray()).toEqual([
      expect.objectContaining({ publicationId: postPub.id, action: "revoke" }),
    ]);
  });
});

describe("marker uniqueness", () => {
  it("createList and updateList refuse a marker already worn by a live list", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));

    await expect(repo.createList({ ...list("l3"), marker: markerAt(0) })).rejects.toThrow(
      /marker already in use/,
    );
    await expect(
      repo.updateList({ ...list("l2-renamed"), id: "l2", marker: markerAt(0), updatedAt: LATER }),
    ).rejects.toThrow(/marker already in use/);

    // Keeping one's own marker is not a clash; a tombstoned list frees its pair.
    await repo.updateList({
      id: "l2",
      name: "Renamed",
      marker: markerAt(1),
      createdAt: NOW,
      updatedAt: LATER,
    });
    await repo.deleteList("l1", LATER);
    await repo.createList({
      id: "l3",
      name: "l3",
      marker: markerAt(0),
      createdAt: NOW,
      updatedAt: LATER,
    });
    expect((await repo.listLists()).map((l) => l.id).sort()).toEqual(["l2", "l3"]);
  });
});
