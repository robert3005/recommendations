/**
 * Deep data-model regressions derived from book/src/data-model.md and
 * book/src/place-identity.md. These exercise repository paths that are not
 * covered by the backup-shape or exact-ref collision audits.
 */
import { linkPlaceToOsm, type Note, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

function freshRepo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

function poi(id: string, name = `Place ${id}`, at = NOW): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name,
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name, amenity: "cafe", wikidata: `Q${id}` },
    resolvedAt: at,
  };
}

async function createList(repo: DexieRepository, id: string): Promise<void> {
  await repo.createList({ id, name: id, createdAt: NOW, updatedAt: NOW });
}

describe("Phase 2 immutable durable identity at the repository boundary", () => {
  it("does not let updatePlace rewrite origin, firstSeen, or completed link history", async () => {
    const repo = freshRepo("phase2-immutable-place-fields");
    try {
      await createList(repo, "list-1");
      const created = (await repo.addToList("list-1", { kind: "poi", poi: poi("101") }, NOW)).place;
      const relinked = linkPlaceToOsm(
        created,
        { ...poi("202", "Replacement", LATER), osmRef: { type: "way", id: "202" } },
        LATER,
        "resolver-match",
      );
      await repo.updatePlace(relinked);
      const before = await repo.getPlace(created.id);
      if (!before?.firstSeen || before.osmRefHistory.length !== 1) {
        throw new Error("identity fixture is incomplete");
      }

      // Callers may submit a stale or tampered whole-object update. A compliant
      // repository may reject it or preserve the immutable fields, but must not
      // persist the rewrite.
      await repo
        .updatePlace({
          ...before,
          origin: "manual",
          firstSeen: { ...before.firstSeen, name: "forged first observation" },
          osmRefHistory: [],
          updatedAt: "2026-07-19T12:00:00.000Z",
        })
        .catch(() => undefined);

      const after = await repo.getPlace(created.id);
      expect(after?.origin).toBe("osm");
      expect(after?.firstSeen).toEqual(before.firstSeen);
      expect(after?.osmRefHistory).toEqual(before.osmRefHistory);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 2 conservative import identity", () => {
  it("does not auto-fold an unlinked imported anchor onto an OSM-linked place by name and coordinates", async () => {
    const repo = freshRepo("phase2-import-manual-vs-osm");
    try {
      await createList(repo, "osm-list");
      const osm = (
        await repo.addToList("osm-list", { kind: "poi", poi: poi("101", "Common Cafe") }, NOW)
      ).place;
      await createList(repo, "import-list");

      const imported = (
        await repo.addToList(
          "import-list",
          {
            kind: "import",
            facts: { name: "Common Cafe", lat: 38.7139, lng: -9.1394 },
          },
          LATER,
        )
      ).place;

      expect(imported.id).not.toBe(osm.id);
      expect(imported).toMatchObject({ origin: "import", resolutionState: "unlinked" });
      expect(await repo.listPlaces()).toHaveLength(2);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 2 live note-edge invariants", () => {
  it("does not create a BlockNoteAttachment for a non-shareable note", async () => {
    const repo = freshRepo("phase2-private-note-attachment");
    try {
      await createList(repo, "list-1");
      const place = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Pin", lat: 1, lng: 2 } },
          NOW,
        )
      ).place;
      const block = (await repo.getGuideBlocks("list-1"))[0]?.block;
      if (!block) throw new Error("place block fixture is missing");
      const note: Note = {
        id: "private-note",
        target: { kind: "place", placeId: place.id },
        body: "Private body",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      await repo.attachNoteToBlock(block.id, note.id, LATER).catch(() => undefined);

      expect(
        (await repo.db.blockNoteAttachments.toArray()).filter((edge) => !edge.deleted),
      ).toHaveLength(0);
    } finally {
      repo.db.close();
    }
  });

  it("does not leave an attachment live when updateNote retargets its note to another place", async () => {
    const repo = freshRepo("phase2-note-retarget-attachment");
    try {
      await createList(repo, "list-1");
      const first = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "First", lat: 1, lng: 2 } },
          NOW,
        )
      ).place;
      const second = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Second", lat: 3, lng: 4 } },
          NOW,
        )
      ).place;
      const firstBlock = (await repo.getGuideBlocks("list-1")).find(
        ({ block }) => block.content.type === "place" && block.content.placeId === first.id,
      )?.block;
      if (!firstBlock) throw new Error("first place block fixture is missing");
      const note: Note = {
        id: "attached-note",
        target: { kind: "place", placeId: first.id },
        body: "Attached body",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      await repo.attachNoteToBlock(firstBlock.id, note.id, NOW);

      await repo
        .updateNote({
          ...note,
          target: { kind: "place", placeId: second.id },
          updatedAt: LATER,
        })
        .catch(() => undefined);

      const stored = await repo.db.notes.get(note.id);
      const liveEdges = (await repo.db.blockNoteAttachments.toArray()).filter(
        (edge) => !edge.deleted && edge.noteId === note.id,
      );
      if (stored?.target.kind === "place" && stored.target.placeId === second.id) {
        expect(liveEdges).toHaveLength(0);
      } else {
        expect(stored?.target).toEqual({ kind: "place", placeId: first.id });
      }
    } finally {
      repo.db.close();
    }
  });
});
