/**
 * Phase 4 invariants (spec/src/sharing.md): the projection carries no private
 * ids/tags/non-shareable notes; snapshot links round-trip, enforce byte limits,
 * and resist decompression bombs; saving a shared guide dedups against the
 * local library and queues unresolved anchors for review.
 */
import { markerAt, type ResolvedPoi } from "@placemarks/domain";
import { deflateSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { projectList } from "./project";
import { saveSharedGuide } from "./saveSharedGuide";
import {
  decodeSnapshot,
  encodeSnapshot,
  SNAPSHOT_INFLATED_LIMIT,
  SnapshotTooLargeError,
} from "./snapshot";

const NOW = "2026-07-19T09:00:00.000Z";

function poi(id = "101", name = "Café Central"): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name,
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    address: "Rua Example 12, Lisboa",
    identityTags: { name, amenity: "cafe", wikidata: "Q123" },
    resolvedAt: NOW,
  };
}

async function seededRepo(): Promise<{ repo: DexieRepository; listId: string }> {
  const repo = new DexieRepository(`share-${crypto.randomUUID()}`);
  await repo.createList({
    id: "list-1",
    name: "Lisbon weekend",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const view = await repo.addToList("list-1", { kind: "poi", poi: poi() }, NOW);
  await repo.assignTag(view.place.id, "private-tag", NOW);
  await repo.createNote({
    id: "n-private",
    target: { kind: "place", placeId: view.place.id },
    body: "Private thoughts",
    mediaIds: [],
    shareable: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.createNote({
    id: "n-shared",
    target: { kind: "place", placeId: view.place.id },
    title: "For friends",
    body: "Great bica ![pic](asset:media-1)",
    mediaIds: ["media-1"],
    shareable: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.addToList(
    "list-1",
    { kind: "manual", facts: { name: "Picnic bench", lat: 38.72, lng: -9.15 } },
    NOW,
  );
  return { repo, listId: "list-1" };
}

describe("shared guide projection", () => {
  it("carries facts and shareable notes but never ids, tags, or private notes", async () => {
    const { repo, listId } = await seededRepo();
    try {
      const projection = await projectList(repo, listId);
      if (!projection) throw new Error("projection missing");
      const { guide, stats } = projection;

      expect(guide.title).toBe("Lisbon weekend");
      expect(stats).toMatchObject({ places: 2, sharedNotes: 1, imagesOmitted: true });

      const payload = JSON.stringify(guide);
      expect(payload).not.toContain("private-tag");
      expect(payload).not.toContain("Private thoughts");
      expect(payload).not.toContain("asset:"); // images become placeholders
      // No local database ids leak: block ids are positional, not PlaceIds.
      const places = await repo.listPlaces();
      for (const view of places) expect(payload).not.toContain(view.place.id);

      const osmBlock = guide.blocks.find((b) => b.type === "place" && b.place.kind === "osm");
      expect(
        osmBlock && osmBlock.type === "place" && osmBlock.place.kind === "osm"
          ? osmBlock.place.lastVerified.stableIds
          : undefined,
      ).toEqual({ wikidata: "Q123" });
    } finally {
      repo.db.close();
    }
  });
});

describe("snapshot codec", () => {
  it("round-trips through the fragment", async () => {
    const { repo, listId } = await seededRepo();
    try {
      const projection = await projectList(repo, listId);
      if (!projection) throw new Error("projection missing");
      const { fragment } = encodeSnapshot(projection.guide);
      expect(decodeSnapshot(fragment)).toEqual(projection.guide);
    } finally {
      repo.db.close();
    }
  });

  it("refuses to generate an oversized link instead of truncating", async () => {
    const { repo, listId } = await seededRepo();
    try {
      const projection = await projectList(repo, listId);
      if (!projection) throw new Error("projection missing");
      const huge = {
        ...projection.guide,
        // Random bytes do not compress — this must push past the limit.
        description: Array.from({ length: 120_000 }, () =>
          Math.floor(Math.random() * 36).toString(36),
        ).join(""),
      };
      expect(() => encodeSnapshot(huge)).toThrow(SnapshotTooLargeError);
    } finally {
      repo.db.close();
    }
  });

  it("rejects decompression bombs and malformed fragments", () => {
    // A zero-filled 8 MiB document compresses tiny but inflates past the cap.
    const bomb = deflateSync(strToU8("0".repeat(SNAPSHOT_INFLATED_LIMIT * 8)));
    let bombFragment = "";
    {
      let binary = "";
      for (const byte of bomb) binary += String.fromCharCode(byte);
      bombFragment = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    }
    expect(() => decodeSnapshot(bombFragment)).toThrow(/damaged|safe limit/);
    expect(() => decodeSnapshot("not-base64!!!")).toThrow();
    expect(() => decodeSnapshot("")).toThrow(/no shared guide/);
    // Valid compression, invalid schema.
    const junk = deflateSync(strToU8(JSON.stringify({ v: 99 })));
    let junkFragment = "";
    {
      let binary = "";
      for (const byte of junk) binary += String.fromCharCode(byte);
      junkFragment = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    }
    expect(() => decodeSnapshot(junkFragment)).toThrow(/not a valid shared guide/);
  });
});

describe("save a shared guide", () => {
  it("imports resolved places, dedups existing ones, and queues unresolved anchors", async () => {
    const { repo, listId } = await seededRepo();
    const target = new DexieRepository(`share-target-${crypto.randomUUID()}`);
    try {
      const projection = await projectList(repo, listId);
      if (!projection) throw new Error("projection missing");
      const guide = projection.guide;

      const resolver = {
        resolveExact: async (ref: { id: string }) =>
          ref.id === "101" ? ({ type: "ok", poi: poi() } as const) : ({ type: "gone" } as const),
        searchNearby: async () => [],
        discover: async () => ({ pois: [], truncated: false }),
      };

      const result = await saveSharedGuide(target, resolver, guide, NOW);
      expect(result).toMatchObject({ added: 2, pending: 0 });
      const names = (await target.listPlaces()).map(
        (v) => v.place.lastVerified?.name ?? v.place.manual?.name,
      );
      expect(names.sort()).toEqual(["Café Central", "Picnic bench"]);
      // The shareable note arrived; the private one never travelled.
      const central = (await target.listPlaces()).find((v) => v.place.currentOsmRef);
      const notes = central ? await target.listNotesForPlace(central.place.id) : [];
      expect(notes.map((n) => n.body).join()).toContain("Great bica");
      expect(notes.map((n) => n.body).join()).not.toContain("Private thoughts");

      // Saving again converges instead of duplicating.
      const again = await saveSharedGuide(target, resolver, guide, NOW);
      expect(again.duplicates).toBe(2);
      expect(await target.listPlaces()).toHaveLength(2);

      // An anchor that no longer resolves becomes a pending review item.
      const goneGuide = {
        ...guide,
        blocks: guide.blocks.map((b) =>
          b.type === "place" && b.place.kind === "osm"
            ? {
                ...b,
                place: {
                  ...b.place,
                  currentOsmRef: { type: "node" as const, id: "410" },
                },
              }
            : b,
        ),
      };
      const fresh = new DexieRepository(`share-pending-${crypto.randomUUID()}`);
      try {
        const pendingResult = await saveSharedGuide(fresh, resolver, goneGuide, NOW);
        expect(pendingResult.pending).toBe(1);
        const reviewRows = await fresh.db.importItems
          .filter((i) => i.status === "review")
          .toArray();
        expect(reviewRows).toHaveLength(1);
        expect(reviewRows[0]?.raw.title).toBe("Café Central");
      } finally {
        fresh.db.close();
      }
    } finally {
      repo.db.close();
      target.db.close();
    }
  });
});
