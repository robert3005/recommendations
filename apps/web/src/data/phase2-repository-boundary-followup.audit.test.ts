/**
 * Follow-up repository-boundary checks from the authoritative 2026-07-19
 * rulings in spec/src/data-model.md. Whole-object updates must not be able to
 * rewrite a completed identity history or leave a note targeting no live row.
 */
import { linkPlaceToOsm, markerAt, type Note, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";
const LATEST = "2026-07-19T12:00:00.000Z";

function repoFor(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`);
}

function poi(id: string, at: string): ResolvedPoi {
  return {
    osmRef: { type: "node", id },
    name: `Place ${id}`,
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { amenity: "cafe", name: `Place ${id}` },
    resolvedAt: at,
  };
}

describe("Phase 2 repository-boundary identity follow-up", () => {
  it("does not persist a current OSM binding change that omits the completed prior interval", async () => {
    const repo = repoFor("phase2-history-required-on-relink");
    try {
      await repo.createList({
        id: "list-1",
        name: "Trip",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const original = (await repo.addToList("list-1", { kind: "poi", poi: poi("101", NOW) }, NOW))
        .place;
      const relinked = linkPlaceToOsm(original, poi("202", LATER), LATER, "resolver-match");

      await repo
        .updatePlace({
          ...relinked,
          // A prefix-only check treats the old empty history as preserved and
          // silently loses the interval for node/101.
          osmRefHistory: [],
        })
        .catch(() => undefined);

      const stored = await repo.getPlace(original.id);
      const nextRef = relinked.currentOsmRef;
      if (!stored || !nextRef) throw new Error("relink fixture did not retain both bindings");
      if (stored.currentOsmRef?.type === nextRef.type && stored.currentOsmRef.id === nextRef.id) {
        // A repository may normalize the transition instead of refusing it,
        // but the completed old binding must then exist exactly once.
        expect(stored.osmRefHistory).toEqual(relinked.osmRefHistory);
      } else {
        expect(stored).toMatchObject({
          currentOsmRef: original.currentOsmRef,
          osmRefHistory: [],
        });
      }
    } finally {
      repo.db.close();
    }
  });

  it("does not persist a fabricated interval when the current binding did not change", async () => {
    const repo = repoFor("phase2-history-fabricated-append");
    try {
      await repo.createList({
        id: "list-1",
        name: "Trip",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const original = (await repo.addToList("list-1", { kind: "poi", poi: poi("101", NOW) }, NOW))
        .place;

      await repo
        .updatePlace({
          ...original,
          osmRefHistory: [
            {
              // Syntactically valid but unrelated to either side of a real
              // binding transition: shape validation alone is insufficient.
              ref: { type: "way", id: "999" },
              linkedAt: NOW,
              unlinkedAt: LATER,
              reason: "resolver-match",
            },
          ],
          updatedAt: LATER,
        })
        .catch(() => undefined);

      await expect(repo.getPlace(original.id)).resolves.toMatchObject({
        currentOsmRef: original.currentOsmRef,
        osmRefHistory: [],
      });
    } finally {
      repo.db.close();
    }
  });

  it("preserves every completed history entry when a longer update rewrites its prefix", async () => {
    const repo = repoFor("phase2-history-prefix");
    try {
      await repo.createList({
        id: "list-1",
        name: "Trip",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const original = (await repo.addToList("list-1", { kind: "poi", poi: poi("101", NOW) }, NOW))
        .place;
      await repo.updatePlace(linkPlaceToOsm(original, poi("202", LATER), LATER, "resolver-match"));
      const before = await repo.getPlace(original.id);
      if (before?.osmRefHistory.length !== 1) {
        throw new Error("relinked identity fixture is incomplete");
      }

      await repo
        .updatePlace({
          ...before,
          // Length-only validation is insufficient: this rewrites the completed
          // entry while making the array look as though it merely grew.
          osmRefHistory: [
            {
              ref: { type: "node", id: "forged" },
              linkedAt: NOW,
              unlinkedAt: LATER,
              reason: "replaced",
            },
            {
              ref: { type: "node", id: "303" },
              linkedAt: LATER,
              unlinkedAt: LATEST,
              reason: "replaced",
            },
          ],
          updatedAt: LATEST,
        })
        .catch(() => undefined);

      const after = await repo.getPlace(original.id);
      expect(after?.osmRefHistory[0]).toEqual(before.osmRefHistory[0]);
    } finally {
      repo.db.close();
    }
  });

  it("serializes concurrent upgrades so an exact OSM ref cannot fork", async () => {
    const repo = repoFor("phase2-concurrent-ref-upgrade");
    try {
      await repo.createList({
        id: "list-a",
        name: "A",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.createList({
        id: "list-b",
        name: "B",
        marker: markerAt(1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const first = (
        await repo.addToList(
          "list-a",
          { kind: "manual", facts: { name: "First pin", lat: 38.7, lng: -9.1 } },
          NOW,
        )
      ).place;
      const second = (
        await repo.addToList(
          "list-b",
          { kind: "manual", facts: { name: "Second pin", lat: 38.71, lng: -9.11 } },
          NOW,
        )
      ).place;
      const match = poi("404", LATER);

      await Promise.allSettled([
        repo.updatePlace(linkPlaceToOsm(first, match, LATER, "owner-confirmed")),
        repo.updatePlace(linkPlaceToOsm(second, match, LATER, "owner-confirmed")),
      ]);

      const holders = (await repo.listPlaces()).filter(
        ({ place }) => place.currentOsmRef?.type === "node" && place.currentOsmRef.id === "404",
      );
      expect(holders).toHaveLength(1);
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 2 repository-boundary note follow-up", () => {
  it("does not let updateNote create a note whose target does not exist", async () => {
    const repo = repoFor("phase2-note-update-is-not-create");
    const orphan: Note = {
      id: "missing-note",
      target: { kind: "place", placeId: "missing-place" },
      body: "This must never materialize",
      mediaIds: [],
      shareable: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    try {
      await repo.updateNote(orphan).catch(() => undefined);
      await expect(repo.db.notes.get(orphan.id)).resolves.toBeUndefined();
    } finally {
      repo.db.close();
    }
  });

  it("does not resurrect a tombstoned note after its target was removed", async () => {
    const repo = repoFor("phase2-note-stale-resurrection");
    try {
      await repo.createList({
        id: "list-1",
        name: "Trip",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Pin", lat: 38.7, lng: -9.1 } },
          NOW,
        )
      ).place;
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "Original body",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      // Bottom-up teardown (2026-07-19): the place refuses to go while the
      // note lives — the owner dismantles the note first, then the place.
      await repo.deleteNote(note.id, LATER);
      await repo.removePlace(place.id, LATER);

      await repo
        .updateNote({ ...note, body: "Stale resurrecting edit", updatedAt: LATEST })
        .catch(() => undefined);

      await expect(repo.db.notes.get(note.id)).resolves.toMatchObject({ deleted: true });
      await expect(repo.getPlace(place.id)).resolves.toBeUndefined();
    } finally {
      repo.db.close();
    }
  });

  it("does not retarget an existing note to a missing aggregate", async () => {
    const repo = repoFor("phase2-note-missing-retarget");
    try {
      await repo.createList({
        id: "list-1",
        name: "Trip",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Pin", lat: 38.7, lng: -9.1 } },
          NOW,
        )
      ).place;
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "Keep me attached to a live target",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      await repo
        .updateNote({
          ...note,
          target: { kind: "place", placeId: "missing-place" },
          updatedAt: LATER,
        })
        .catch(() => undefined);

      expect((await repo.db.notes.get(note.id))?.target).toEqual(note.target);
    } finally {
      repo.db.close();
    }
  });
});
