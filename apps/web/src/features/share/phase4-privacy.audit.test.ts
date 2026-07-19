/** Additional Phase 4 checks from the current authoritative sharing design. */
import type { PoiResolver, ResolvedPoi } from "@placemarks/domain";
import type { SharedGuide, SharedPlaceAnchor, SharedPlaceEvidence } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { projectGuide } from "./project";
import { resolveSharedAnchor } from "./resolveShared";
import { saveSharedGuide } from "./saveSharedGuide";

const NOW = "2026-07-19T13:00:00.000Z";

function evidence(overrides: Partial<SharedPlaceEvidence> = {}): SharedPlaceEvidence {
  return {
    osmRef: { type: "node", id: "101" },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    address: "Rua Example 12, Lisboa",
    stableIds: { wikidata: "Q123" },
    observedAt: NOW,
    ...overrides,
  };
}

function anchor(overrides: Partial<SharedPlaceAnchor> = {}): SharedPlaceAnchor {
  return {
    kind: "osm",
    currentOsmRef: { type: "node", id: "101" },
    firstSeen: evidence(),
    lastVerified: evidence(),
    ...overrides,
  } as SharedPlaceAnchor;
}

function poi(id: string, overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "way", id },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: "Café Central", wikidata: "Q123" },
    resolvedAt: NOW,
    ...overrides,
  };
}

const unavailableResolver = (): PoiResolver => ({
  resolveExact: async () => ({ type: "gone" }),
  searchNearby: async () => [],
  discover: async () => ({ pois: [], truncated: false }),
});

describe("Phase 4 public projection privacy", () => {
  it("omits reference-style local images instead of leaking asset ids into a snapshot", async () => {
    const repo = new DexieRepository(`phase4-reference-image-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Private media",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Viewpoint", lat: 38.7, lng: -9.1 } },
        NOW,
      );
      await repo.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.place.id },
        body: "A private photo: ![sunset][photo]\n\n[photo]: asset:media-secret",
        mediaIds: ["media-secret"],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const projection = await projectGuide(repo, "list-1");
      if (!projection) throw new Error("projection missing");
      const payload = JSON.stringify(projection.guide);

      expect(payload).not.toContain("asset:media-secret");
      expect(payload).toContain("image omitted");
      expect(projection.stats.imagesOmitted).toBe(true);
    } finally {
      repo.db.close();
    }
  });

  it("omits a reference-style remote image destination from the snapshot payload", async () => {
    const repo = new DexieRepository(`phase4-reference-remote-image-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Remote media disclosure",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Viewpoint", lat: 38.7, lng: -9.1 } },
        NOW,
      );
      const privateDestination = "https://private.example/photos/family-trip.jpg";
      await repo.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.place.id },
        body: `A private photo: ![family][photo]\n\n[photo]: ${privateDestination}`,
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const projection = await projectGuide(repo, "list-1");
      if (!projection) throw new Error("projection missing");
      const payload = JSON.stringify(projection.guide);

      expect(payload).not.toContain(privateDestination);
      expect(payload).toMatch(
        /(?:image|photo)[^"\\n]{0,40}(?:omit|remove|unavailable)|(?:omit|remove)[^"\\n]{0,40}(?:image|photo)/i,
      );
    } finally {
      repo.db.close();
    }
  });

  it("matches the SharedGuide schema in the book and does not add an undocumented colour field", async () => {
    const repo = new DexieRepository(`phase4-schema-drift-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Schema contract",
        color: "#dc2626",
        createdAt: NOW,
        updatedAt: NOW,
      });

      const projection = await projectGuide(repo, "list-1");

      expect(projection?.guide).not.toHaveProperty("color");
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 4 recovery honesty", () => {
  it("does not describe ambiguous high-confidence replacements as definitively missing", async () => {
    const candidates = [poi("201"), poi("202")];
    const resolver: PoiResolver = {
      resolveExact: async () => ({ type: "gone" }),
      searchNearby: async () => candidates,
      discover: async () => ({ pois: [], truncated: false }),
    };

    const result = await resolveSharedAnchor(resolver, anchor());

    expect(["ambiguous", "review", "needs-review", "evidence"]).toContain(result.state);
  });
});

describe("Phase 4 pending shared-guide import", () => {
  it("retains the copied anchor and selected note in the interop review queue", async () => {
    const repo = new DexieRepository(`phase4-pending-evidence-${crypto.randomUUID()}`);
    const guide: SharedGuide = {
      v: 1,
      title: "Pending guide",
      blocks: [
        {
          id: "b1",
          type: "place",
          place: anchor(),
          notes: [{ title: "Tip", body: "Bring cash" }],
        },
      ],
      contentHash: "fixture",
    };

    try {
      const result = await saveSharedGuide(repo, unavailableResolver(), guide, NOW);
      const row = await repo.db.importItems.where("batchId").notEqual("").first();

      expect(result).toMatchObject({ added: 0, pending: 1 });
      expect(await repo.listPlaces()).toHaveLength(0);
      expect(row).toMatchObject({
        status: "review",
        coords: { lat: 38.7139, lng: -9.1394 },
        raw: {
          title: "Café Central",
          address: "Rua Example 12, Lisboa",
          url: "https://www.openstreetmap.org/node/101",
          note: "Bring cash",
        },
      });
    } finally {
      repo.db.close();
    }
  });
});
