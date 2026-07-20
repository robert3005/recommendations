/**
 * Phase 8 acceptance (spec/src/roadmap.md): two devices signed into one
 * account converge — lists, posts, notes, tags, places — after concurrent
 * offline edits without silent loss; a conflicting note edit yields a
 * recoverable conflict copy; and with sync off the app behaves exactly as the
 * local-first build. The transport here is the REAL sync service app run
 * in-process.
 */
import { markerAt } from "@placemarks/domain";
import { createSyncApp, MemorySyncStorage } from "@placemarks/sync-service";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { completeLogin, requestLoginCode, syncNow } from "./engine";

const NOW = "2026-07-20T12:00:00.000Z";

class RecordingMailer {
  codes = new Map<string, string>();
  async send(email: string, code: string): Promise<void> {
    this.codes.set(email, code);
  }
}

function service() {
  const mailer = new RecordingMailer();
  const app = createSyncApp({ storage: new MemorySyncStorage(), mailer });
  // Route the client's fetch straight into the Hono app — no network.
  const fetcher: typeof fetch = (input, init) => Promise.resolve(app.request(String(input), init));
  return { mailer, fetcher };
}

async function device(label: string): Promise<DexieRepository> {
  // Distinct actors: two "devices" share this test's jsdom localStorage.
  return new DexieRepository(`${label}-${crypto.randomUUID()}`, {
    actorId: `${label}-actor`,
  });
}

async function signIn(
  repo: DexieRepository,
  email: string,
  { mailer, fetcher }: { mailer: RecordingMailer; fetcher: typeof fetch },
): Promise<void> {
  await requestLoginCode(email, fetcher);
  const code = mailer.codes.get(email);
  if (!code) throw new Error("no code");
  await completeLogin(repo, email, code, fetcher);
}

describe("multi-device sync", () => {
  it("converges lists, places, tags, notes, and posts across two devices", async () => {
    const wire = service();
    const a = await device("sync-a");
    const b = await device("sync-b");
    try {
      await signIn(a, "owner@example.com", wire);
      await signIn(b, "owner@example.com", wire);

      // Device A curates offline…
      await a.createList({
        id: "list-1",
        name: "Lisbon",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await a.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Café Central", lat: 38.7139, lng: -9.1394 } },
          NOW,
        )
      ).place;
      await a.assignTag(place.id, "coffee", NOW);
      await a.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Order",
        body: "The bica at the counter.",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await a.createPost({
        id: "post-1",
        title: "Coffee notes",
        listId: "list-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await a.embedPlaceInPost("post-1", place.id, NOW);

      // …then both devices sync.
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      expect((await b.listLists()).map((l) => l.name)).toEqual(["Lisbon"]);
      const bPlaces = await b.listPlaces();
      expect(bPlaces).toHaveLength(1);
      expect(bPlaces[0]?.tags.map((t) => t.name)).toEqual(["coffee"]);
      expect((await b.listNotesForPlace(place.id)).map((n) => n.body)).toEqual([
        "The bica at the counter.",
      ]);
      expect((await b.listPostsForList("list-1")).map((p) => p.title)).toEqual(["Coffee notes"]);
      expect((await b.getPostBlocks("post-1")).map((v) => v.block.content.type)).toEqual(["place"]);
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it("preserves both bodies of a concurrent note edit as a recoverable conflict copy", async () => {
    const wire = service();
    const a = await device("conflict-a");
    const b = await device("conflict-b");
    try {
      await signIn(a, "owner@example.com", wire);
      await signIn(b, "owner@example.com", wire);
      await a.createList({
        id: "list-1",
        name: "Lisbon",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await a.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Café Central", lat: 38.7139, lng: -9.1394 } },
          NOW,
        )
      ).place;
      await a.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "original",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      // Concurrent offline edits of the SAME note on both devices.
      const aNote = (await a.listNotesForPlace(place.id))[0];
      const bNote = (await b.listNotesForPlace(place.id))[0];
      if (!aNote || !bNote) throw new Error("seed failed");
      await a.updateNote({ ...aNote, body: "device A words", updatedAt: NOW });
      await b.updateNote({ ...bNote, body: "device B words", updatedAt: NOW });

      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      const aBodies = (await a.listNotesForPlace(place.id)).map((n) => n.body).sort();
      const bBodies = (await b.listNotesForPlace(place.id)).map((n) => n.body).sort();
      // Converged: the same winner on both, and NEITHER body lost — the loser
      // survives as a conflict copy that itself synced to both devices.
      expect(aBodies).toEqual(bBodies);
      expect(aBodies).toHaveLength(2);
      expect(aBodies).toContain("device A words");
      expect(aBodies).toContain("device B words");
      const titles = (await a.listNotesForPlace(place.id)).map((n) => n.title ?? "");
      expect(titles.some((title) => title.startsWith("(conflict copy)"))).toBe(true);
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it("rescues a note edit that raced a remote teardown — never a silent drop", async () => {
    const wire = service();
    const a = await device("race-a");
    const b = await device("race-b");
    try {
      await signIn(a, "owner@example.com", wire);
      await signIn(b, "owner@example.com", wire);
      await a.createList({
        id: "list-1",
        name: "Lisbon",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await a.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Café Central", lat: 38.7139, lng: -9.1394 } },
          NOW,
        )
      ).place;
      await a.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "original",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      // Device B dismantles bottom-up (delete the note, then the place) while
      // device A concurrently edits the same note offline.
      const bNote = (await b.listNotesForPlace(place.id))[0];
      if (!bNote) throw new Error("seed failed");
      await b.deleteNote(bNote.id, NOW);
      await b.removePlace(place.id, NOW);
      const aNote = (await a.listNotesForPlace(place.id))[0];
      if (!aNote) throw new Error("seed failed");
      await a.updateNote({ ...aNote, body: "words A kept writing", updatedAt: NOW });

      await syncNow(b, undefined, wire.fetcher);
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);
      await syncNow(a, undefined, wire.fetcher);

      // Converged: the place is gone on both…
      expect(await a.listPlaces()).toHaveLength(0);
      expect(await b.listPlaces()).toHaveLength(0);
      // …and the raced words were rescued, not silently dropped.
      const rescued = await a.db.syncConflicts.toArray();
      expect(rescued.some((conflict) => conflict.body === "words A kept writing")).toBe(true);
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it("does nothing at all without a signed-in scope", async () => {
    const wire = service();
    const solo = await device("solo");
    try {
      await solo.createList({
        id: "list-1",
        name: "Mine",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const outcome = await syncNow(solo, undefined, wire.fetcher);
      expect(outcome).toEqual({ pushed: 0, applied: 0 });
      // The outbox still records the mutations — sync can be enabled later.
      expect(await solo.db.mutationOutbox.count()).toBeGreaterThan(0);
      expect((await solo.listLists()).map((l) => l.name)).toEqual(["Mine"]);
    } finally {
      solo.db.close();
    }
  });
});
