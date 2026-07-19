/**
 * DexieRepository invariants (spec/src/data-model.md) on fake-indexeddb.
 * Core rule under test: membership is existence — a place persists only while
 * it belongs to at least one list.
 */
import { type List, linkPlaceToOsm, type ResolvedPoi } from "@placemarks/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T13:00:00.000Z";

let repo: DexieRepository;
let counter = 0;

beforeEach(() => {
  counter += 1;
  repo = new DexieRepository(`test-db-${Date.now()}-${counter}`);
});

function poi(overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    website: "https://cafecentral.pt/",
    identityTags: { name: "Café Central", amenity: "cafe" },
    resolvedAt: NOW,
    ...overrides,
  };
}

function list(id: string, name = id): List {
  return { id, name, createdAt: NOW, updatedAt: NOW };
}

describe("membership is existence", () => {
  it("a place enters the library by being added to a list", async () => {
    await repo.createList(list("l1", "Lisbon"));
    const view = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    expect(view.place.origin).toBe("osm");
    expect(await repo.listIdsForPlace(view.place.id)).toEqual(["l1"]);
    expect(await repo.listPlaces()).toHaveLength(1);
  });

  it("deduplicates by exact OSM ref across lists — one place, several memberships", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));
    const first = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    const second = await repo.addToList(
      "l2",
      { kind: "poi", poi: poi({ resolvedAt: LATER }) },
      LATER,
    );
    expect(second.place.id).toBe(first.place.id);
    expect((await repo.listIdsForPlace(first.place.id)).sort()).toEqual(["l1", "l2"]);
    expect(await repo.listPlaces()).toHaveLength(1);
  });

  it("deduplicates via historical refs after a relink, keeping the newer binding", async () => {
    await repo.createList(list("l1"));
    const view = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    const relinked = linkPlaceToOsm(
      view.place,
      poi({ osmRef: { type: "way", id: "999" }, resolvedAt: LATER }),
      LATER,
      "resolver-match",
    );
    await repo.updatePlace(relinked);
    await repo.createList(list("l2"));
    // Adding by the OLD node ref must reuse the same place, not fork identity.
    const again = await repo.addToList("l2", { kind: "poi", poi: poi() }, LATER);
    expect(again.place.id).toBe(view.place.id);
    expect(again.place.currentOsmRef).toEqual({ type: "way", id: "999" });
  });

  it("forbids the same place twice in one list", async () => {
    await repo.createList(list("l1"));
    await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    await expect(repo.addToList("l1", { kind: "poi", poi: poi() }, LATER)).rejects.toThrow(
      /already/,
    );
  });

  it("manual pins are created straight into a list, unlinked", async () => {
    await repo.createList(list("l1"));
    const view = await repo.addToList(
      "l1",
      { kind: "manual", facts: { name: "Picnic bench", lat: 38.7, lng: -9.1 } },
      NOW,
    );
    expect(view.place.origin).toBe("manual");
    expect(view.place.resolutionState).toBe("unlinked");
    expect(await repo.listIdsForPlace(view.place.id)).toEqual(["l1"]);
  });

  it("removing the last membership removes the place with tags and notes", async () => {
    await repo.createList(list("l1"));
    const view = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    await repo.assignTag(view.place.id, "coffee", NOW);
    await repo.createNote({
      id: "n1",
      target: { kind: "place", placeId: view.place.id },
      body: "great espresso",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const blocks = await repo.getGuideBlocks("l1");
    const blockId = blocks[0]?.block.id;
    if (!blockId) throw new Error("no block");

    await repo.removeBlock(blockId, LATER);

    expect(await repo.getPlaceView(view.place.id)).toBeUndefined();
    expect(await repo.listPlaces()).toHaveLength(0);
    expect(await repo.listNotesForPlace(view.place.id)).toHaveLength(0);
  });

  it("removing one of several memberships keeps the place", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));
    const view = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    await repo.addToList("l2", { kind: "existing", placeId: view.place.id }, NOW);
    const l1Blocks = await repo.getGuideBlocks("l1");
    await repo.removeBlock(l1Blocks[0]?.block.id ?? "", LATER);
    expect(await repo.getPlaceView(view.place.id)).toBeDefined();
    expect(await repo.listIdsForPlace(view.place.id)).toEqual(["l2"]);
  });

  it("removePlace removes it from every list along with tags and notes", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));
    const view = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    await repo.addToList("l2", { kind: "existing", placeId: view.place.id }, NOW);
    await repo.assignTag(view.place.id, "coffee", NOW);

    await repo.removePlace(view.place.id, LATER);

    expect(await repo.getPlaceView(view.place.id)).toBeUndefined();
    expect(await repo.getGuideBlocks("l1")).toHaveLength(0);
    expect(await repo.getGuideBlocks("l2")).toHaveLength(0);
  });

  it("deleting a list removes places whose only membership it held — and keeps shared ones", async () => {
    await repo.createList(list("l1"));
    await repo.createList(list("l2"));
    const only = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    const shared = await repo.addToList(
      "l1",
      { kind: "poi", poi: poi({ osmRef: { type: "node", id: "102" }, name: "Other" }) },
      NOW,
    );
    await repo.addToList("l2", { kind: "existing", placeId: shared.place.id }, NOW);

    await repo.deleteList("l1", LATER);

    expect(await repo.getPlaceView(only.place.id)).toBeUndefined();
    expect(await repo.getPlaceView(shared.place.id)).toBeDefined();
    expect(await repo.listIdsForPlace(shared.place.id)).toEqual(["l2"]);
  });
});

describe("tags", () => {
  it("reuses tags by normalized name and enforces one live assignment per pair", async () => {
    await repo.createList(list("l1"));
    const a = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    const b = await repo.addToList(
      "l1",
      { kind: "poi", poi: poi({ osmRef: { type: "node", id: "102" } }) },
      NOW,
    );
    await repo.assignTag(a.place.id, "Coffee", NOW);
    await repo.assignTag(b.place.id, "  coffee ", NOW);
    expect(await repo.listTags()).toHaveLength(1);
    await repo.assignTag(a.place.id, "COFFEE", NOW);
    expect((await repo.getPlaceView(a.place.id))?.tags).toHaveLength(1);
  });

  it("supports re-assignment after removal", async () => {
    await repo.createList(list("l1"));
    const view = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    await repo.assignTag(view.place.id, "coffee", NOW);
    const tag = (await repo.listTags())[0];
    if (!tag) throw new Error("no tag");
    await repo.removeTagAssignment(view.place.id, tag.id, LATER);
    expect((await repo.getPlaceView(view.place.id))?.tags).toHaveLength(0);
    await repo.assignTag(view.place.id, "coffee", LATER);
    expect((await repo.getPlaceView(view.place.id))?.tags).toHaveLength(1);
  });

  it("rejects tagging an unknown place and empty tag names", async () => {
    await expect(repo.assignTag("nope", "coffee", NOW)).rejects.toThrow(/not found/);
    await repo.createList(list("l1"));
    const view = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    await expect(repo.assignTag(view.place.id, "   ", NOW)).rejects.toThrow(/empty/);
  });
});

describe("blocks and ordering", () => {
  it("keeps blocks ordered and moves them", async () => {
    await repo.createList(list("l1"));
    const a = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    await repo.addToList(
      "l1",
      { kind: "poi", poi: poi({ osmRef: { type: "node", id: "102" }, name: "Other" }) },
      NOW,
    );
    let blocks = await repo.getGuideBlocks("l1");
    expect(blocks.map((v) => v.place?.id)).toEqual([a.place.id, blocks[1]?.place?.id]);
    const second = blocks[1]?.block.id;
    if (!second) throw new Error("no block");
    await repo.moveBlock(second, blocks[0]?.block.id ?? null, LATER);
    blocks = await repo.getGuideBlocks("l1");
    expect(blocks[1]?.place?.id).toBe(a.place.id);
  });

  it("section notes are created and die with their blocks", async () => {
    await repo.createList(list("l1"));
    const section = await repo.addSectionBlock("l1", "Intro text", NOW, "Intro");
    expect((await repo.getGuideBlocks("l1"))[0]?.sectionNote?.body).toBe("Intro text");
    await repo.removeBlock(section.id, LATER);
    expect(await repo.getGuideBlocks("l1")).toHaveLength(0);
  });
});

describe("note attachments", () => {
  it("attaches only notes about the block's place", async () => {
    await repo.createList(list("l1"));
    const a = await repo.addToList("l1", { kind: "poi", poi: poi() }, NOW);
    const b = await repo.addToList(
      "l1",
      { kind: "poi", poi: poi({ osmRef: { type: "node", id: "102" } }) },
      NOW,
    );
    await repo.createNote({
      id: "n1",
      target: { kind: "place", placeId: a.place.id },
      body: "note body",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const blocks = await repo.getGuideBlocks("l1");
    const blockA = blocks.find((v) => v.place?.id === a.place.id)?.block.id;
    const blockB = blocks.find((v) => v.place?.id === b.place.id)?.block.id;
    if (!blockA || !blockB) throw new Error("blocks missing");
    await repo.attachNoteToBlock(blockA, "n1", NOW);
    await expect(repo.attachNoteToBlock(blockB, "n1", NOW)).rejects.toThrow(/different place/);
    await repo.deleteNote("n1", LATER);
    expect((await repo.getGuideBlocks("l1"))[0]?.attachments).toHaveLength(0);
  });
});

describe("media", () => {
  it("stores and retrieves asset metadata with its blob", async () => {
    const blob = new Blob(["fake-image-bytes"], { type: "image/webp" });
    await repo.putMedia(
      { id: "m1", mime: "image/webp", localBlobKey: "blob-m1", createdAt: NOW, updatedAt: NOW },
      blob,
    );
    const media = await repo.getMedia("m1");
    expect(media?.asset.mime).toBe("image/webp");
    // fake-indexeddb demotes Blob prototypes in jsdom; presence + metadata suffice.
    expect(media?.blob).toBeDefined();
  });
});
