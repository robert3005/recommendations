/**
 * DexieRepository invariants (book/src/data-model.md), on fake-indexeddb.
 * Each test gets a fresh database.
 */
import { linkPlaceToOsm, type ResolvedPoi } from "@placemarks/domain";
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

describe("saving places", () => {
  it("creates a Place + SavedPlace atomically for a new POI", async () => {
    const view = await repo.savePoi(poi(), NOW);
    expect(view.place.origin).toBe("osm");
    expect(view.place.resolutionState).toBe("resolved");
    expect(view.savedPlace.placeId).toBe(view.place.id);
  });

  it("deduplicates by exact OSM ref — saving twice yields one place, one save", async () => {
    const first = await repo.savePoi(poi(), NOW);
    const second = await repo.savePoi(poi({ resolvedAt: LATER }), LATER);
    expect(second.place.id).toBe(first.place.id);
    expect(second.savedPlace.id).toBe(first.savedPlace.id);
    expect(await repo.listSavedPlaces()).toHaveLength(1);
    // Re-saving via the current ref refreshed the evidence.
    expect(second.place.lastVerified?.observedAt).toBe(LATER);
  });

  it("deduplicates via historical refs after a relink, keeping the newer binding", async () => {
    const view = await repo.savePoi(poi(), NOW);
    const relinked = linkPlaceToOsm(
      view.place,
      poi({ osmRef: { type: "way", id: "999" }, resolvedAt: LATER }),
      LATER,
      "resolver-match",
    );
    await repo.updatePlace(relinked);
    // Saving by the OLD node ref must reuse the same place, not fork identity.
    const again = await repo.savePoi(poi(), LATER);
    expect(again.place.id).toBe(view.place.id);
    expect(again.place.currentOsmRef).toEqual({ type: "way", id: "999" });
  });

  it("saves manual pins as unlinked places", async () => {
    const view = await repo.saveManual({ name: "Picnic bench", lat: 38.7, lng: -9.1 }, NOW);
    expect(view.place.origin).toBe("manual");
    expect(view.place.resolutionState).toBe("unlinked");
    expect(view.place.currentOsmRef).toBeUndefined();
  });
});

describe("unsave cascade", () => {
  it("tombstones tag assignments, guide blocks, and place notes — not list-section notes", async () => {
    const view = await repo.savePoi(poi(), NOW);
    await repo.assignTag(view.savedPlace.id, "coffee", NOW);
    await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
    await repo.addPlaceBlock("l1", view.savedPlace.id, NOW);
    await repo.addSectionBlock("l1", "Intro text", NOW);
    await repo.createNote({
      id: "n1",
      target: { kind: "place", placeId: view.place.id },
      body: "great espresso",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await repo.unsave(view.savedPlace.id, LATER);

    expect(await repo.getSavedPlace(view.savedPlace.id)).toBeUndefined();
    expect(await repo.listNotesForPlace(view.place.id)).toHaveLength(0);
    const blocks = await repo.getGuideBlocks("l1");
    // The place block is gone; the section survives.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.block.content.type).toBe("section");
  });
});

describe("tags", () => {
  it("reuses tags by normalized name and enforces one live assignment per pair", async () => {
    const a = await repo.savePoi(poi(), NOW);
    const b = await repo.savePoi(poi({ osmRef: { type: "node", id: "102" } }), NOW);
    await repo.assignTag(a.savedPlace.id, "Coffee", NOW);
    await repo.assignTag(b.savedPlace.id, "  coffee ", NOW);
    expect(await repo.listTags()).toHaveLength(1);
    // Idempotent within a pair.
    const again = await repo.assignTag(a.savedPlace.id, "COFFEE", NOW);
    const first = (await repo.getSavedPlace(a.savedPlace.id))?.tags;
    expect(first).toHaveLength(1);
    expect(again.savedPlaceId).toBe(a.savedPlace.id);
  });

  it("supports re-assignment after removal", async () => {
    const view = await repo.savePoi(poi(), NOW);
    const assignment = await repo.assignTag(view.savedPlace.id, "coffee", NOW);
    await repo.removeTagAssignment(view.savedPlace.id, assignment.tagId, LATER);
    expect((await repo.getSavedPlace(view.savedPlace.id))?.tags).toHaveLength(0);
    await repo.assignTag(view.savedPlace.id, "coffee", LATER);
    expect((await repo.getSavedPlace(view.savedPlace.id))?.tags).toHaveLength(1);
  });

  it("rejects tagging an unknown saved place and empty tag names", async () => {
    await expect(repo.assignTag("nope", "coffee", NOW)).rejects.toThrow(/not found/);
    const view = await repo.savePoi(poi(), NOW);
    await expect(repo.assignTag(view.savedPlace.id, "   ", NOW)).rejects.toThrow(/empty/);
  });
});

describe("guides", () => {
  it("keeps blocks ordered and forbids duplicate place blocks", async () => {
    const a = await repo.savePoi(poi(), NOW);
    const b = await repo.savePoi(poi({ osmRef: { type: "node", id: "102" }, name: "Other" }), NOW);
    await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
    await repo.addSectionBlock("l1", "Morning", NOW, "Morning");
    await repo.addPlaceBlock("l1", a.savedPlace.id, NOW);
    await repo.addPlaceBlock("l1", b.savedPlace.id, NOW);
    await expect(repo.addPlaceBlock("l1", a.savedPlace.id, NOW)).rejects.toThrow(/already/);
    const blocks = await repo.getGuideBlocks("l1");
    expect(blocks.map((v) => v.block.content.type)).toEqual(["section", "place", "place"]);
  });

  it("moves blocks before a sibling and to the end", async () => {
    const a = await repo.savePoi(poi(), NOW);
    await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
    const s1 = await repo.addSectionBlock("l1", "Intro", NOW);
    const p1 = await repo.addPlaceBlock("l1", a.savedPlace.id, NOW);
    const s2 = await repo.addSectionBlock("l1", "Afternoon", NOW);
    // Move "Afternoon" before the place block.
    await repo.moveBlock(s2.id, p1.id, LATER);
    let ids = (await repo.getGuideBlocks("l1")).map((v) => v.block.id);
    expect(ids).toEqual([s1.id, s2.id, p1.id]);
    // Move intro to the end.
    await repo.moveBlock(s1.id, null, LATER);
    ids = (await repo.getGuideBlocks("l1")).map((v) => v.block.id);
    expect(ids).toEqual([s2.id, p1.id, s1.id]);
  });

  it("creates and deletes section notes with their blocks", async () => {
    await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
    const section = await repo.addSectionBlock("l1", "Intro text", NOW, "Intro");
    const blocks = await repo.getGuideBlocks("l1");
    expect(blocks[0]?.sectionNote?.body).toBe("Intro text");
    await repo.removeBlock(section.id, LATER);
    expect(await repo.getGuideBlocks("l1")).toHaveLength(0);
  });

  it("deleting a list tombstones blocks and section notes but never saved places", async () => {
    const a = await repo.savePoi(poi(), NOW);
    await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
    await repo.addPlaceBlock("l1", a.savedPlace.id, NOW);
    await repo.addSectionBlock("l1", "Intro", NOW);
    await repo.deleteList("l1", LATER);
    expect(await repo.getList("l1")).toBeUndefined();
    expect(await repo.getGuideBlocks("l1")).toHaveLength(0);
    expect(await repo.getSavedPlace(a.savedPlace.id)).toBeDefined();
  });
});

describe("note attachments", () => {
  async function guideWithPlace() {
    const view = await repo.savePoi(poi(), NOW);
    await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
    const block = await repo.addPlaceBlock("l1", view.savedPlace.id, NOW);
    return { view, block };
  }

  it("attaches a note about the block's place, uniquely", async () => {
    const { view, block } = await guideWithPlace();
    await repo.createNote({
      id: "n1",
      target: { kind: "place", placeId: view.place.id },
      body: "note body",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.attachNoteToBlock(block.id, "n1", NOW);
    const again = await repo.attachNoteToBlock(block.id, "n1", LATER);
    const blocks = await repo.getGuideBlocks("l1");
    expect(blocks[0]?.attachments).toHaveLength(1);
    expect(again.createdAt).toBe(NOW); // reused, not duplicated
  });

  it("rejects attaching a note about a different place", async () => {
    const { block } = await guideWithPlace();
    const other = await repo.savePoi(poi({ osmRef: { type: "node", id: "102" } }), NOW);
    await repo.createNote({
      id: "n2",
      target: { kind: "place", placeId: other.place.id },
      body: "wrong place",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(repo.attachNoteToBlock(block.id, "n2", NOW)).rejects.toThrow(/different place/);
  });

  it("rejects attaching to a section block", async () => {
    await repo.createList({ id: "l1", name: "Lisbon", createdAt: NOW, updatedAt: NOW });
    const section = await repo.addSectionBlock("l1", "Intro", NOW);
    await expect(repo.attachNoteToBlock(section.id, "any", NOW)).rejects.toThrow(/place block/);
  });

  it("deleting a note detaches it everywhere", async () => {
    const { view, block } = await guideWithPlace();
    await repo.createNote({
      id: "n1",
      target: { kind: "place", placeId: view.place.id },
      body: "note body",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.attachNoteToBlock(block.id, "n1", NOW);
    await repo.deleteNote("n1", LATER);
    const blocks = await repo.getGuideBlocks("l1");
    expect(blocks[0]?.attachments).toHaveLength(0);
  });
});

describe("media", () => {
  it("stores and retrieves asset metadata with its blob", async () => {
    const blob = new Blob(["fake-image-bytes"], { type: "image/webp" });
    await repo.putMedia(
      {
        id: "m1",
        mime: "image/webp",
        localBlobKey: "blob-m1",
        createdAt: NOW,
        updatedAt: NOW,
      },
      blob,
    );
    const media = await repo.getMedia("m1");
    expect(media?.asset.mime).toBe("image/webp");
    // fake-indexeddb's structured clone demotes Blob prototypes in jsdom, so assert
    // presence + metadata here; real-browser Blob round-tripping is covered by e2e.
    expect(media?.blob).toBeDefined();
    expect(media?.asset.localBlobKey).toBe("blob-m1");
  });
});
