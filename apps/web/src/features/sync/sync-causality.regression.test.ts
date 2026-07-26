import { markerAt, type Publication } from "@placemarks/domain";
import { createSyncApp, MemorySyncStorage } from "@placemarks/sync-service";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { completeLogin, requestLoginCode, syncNow } from "./engine";

const NOW = "2026-07-20T10:00:00.000Z";
const LATER = "2026-07-20T11:00:00.000Z";

class RecordingMailer {
  readonly codes = new Map<string, string>();

  async send(email: string, code: string): Promise<void> {
    this.codes.set(email, code);
  }
}

function syncService(): { mailer: RecordingMailer; fetcher: typeof fetch } {
  const mailer = new RecordingMailer();
  const app = createSyncApp({ storage: new MemorySyncStorage(), mailer });
  return {
    mailer,
    fetcher: (input, init) => Promise.resolve(app.request(String(input), init)),
  };
}

function device(label: string, dbName?: string): DexieRepository {
  return new DexieRepository(dbName ?? `${label}-${crypto.randomUUID()}`, {
    actorId: `${label}-actor`,
  });
}

async function signIn(
  repo: DexieRepository,
  email: string,
  wire: { mailer: RecordingMailer; fetcher: typeof fetch },
): Promise<void> {
  await requestLoginCode(email, wire.fetcher);
  const code = wire.mailer.codes.get(email);
  if (!code) throw new Error("login code missing");
  await completeLogin(repo, email, code, wire.fetcher);
}

describe("sync causal protocol regressions", () => {
  it("treats an observed-then-edited note as a causal successor, not a conflict", async () => {
    const wire = syncService();
    const a = device("causal-a");
    const b = device("causal-b");
    try {
      await signIn(a, "owner@example.com", wire);
      await signIn(b, "owner@example.com", wire);
      await a.createList({
        id: "list-1",
        name: "Causal list",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await a.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Pin", lat: 51.5, lng: -0.12 } },
          NOW,
        )
      ).place;
      await a.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        body: "seed",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      const onA = (await a.listNotesForPlace(place.id))[0];
      if (!onA) throw new Error("note missing on A");
      await a.updateNote({ ...onA, body: "A revision", updatedAt: LATER });
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      const observedOnB = (await b.listNotesForPlace(place.id))[0];
      if (!observedOnB) throw new Error("note missing on B");
      await b.updateNote({ ...observedOnB, body: "B after observing A", updatedAt: LATER });
      await syncNow(b, undefined, wire.fetcher);
      await syncNow(a, undefined, wire.fetcher);

      const notes = await a.listNotesForPlace(place.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ body: "B after observing A" });
      expect(notes[0]?.title ?? "").not.toMatch(/^\(conflict copy\)/);
      expect(await a.db.syncConflicts.count()).toBe(0);
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it("lets a fresh third device retain both concurrent bodies without duplicate copies", async () => {
    const wire = syncService();
    const a = device("frontier-a");
    const b = device("frontier-b");
    const fresh = device("frontier-fresh");
    try {
      await signIn(a, "frontier@example.com", wire);
      await signIn(b, "frontier@example.com", wire);
      await a.createList({
        id: "frontier-list",
        name: "Frontier",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const place = (
        await a.addToList(
          "frontier-list",
          { kind: "manual", facts: { name: "Pin", lat: 51.5, lng: -0.12 } },
          NOW,
        )
      ).place;
      await a.createNote({
        id: "frontier-note",
        target: { kind: "place", placeId: place.id },
        body: "seed",
        mediaIds: [],
        shareable: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      const noteA = (await a.listNotesForPlace(place.id))[0];
      const noteB = (await b.listNotesForPlace(place.id))[0];
      if (!noteA || !noteB) throw new Error("seed note missing");
      await a.updateNote({ ...noteA, body: "body A", updatedAt: LATER });
      await b.updateNote({ ...noteB, body: "body B", updatedAt: LATER });
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);

      await signIn(fresh, "frontier@example.com", wire);
      await syncNow(fresh, undefined, wire.fetcher);
      await syncNow(a, undefined, wire.fetcher);
      await syncNow(b, undefined, wire.fetcher);
      await syncNow(fresh, undefined, wire.fetcher);

      for (const repo of [a, b, fresh]) {
        const notes = await repo.listNotesForPlace(place.id);
        expect(notes.map((note) => note.body).sort()).toEqual(["body A", "body B"]);
        expect(notes.filter((note) => note.title?.startsWith("(conflict copy)"))).toHaveLength(1);
      }
      const copyIds = await Promise.all(
        [a, b, fresh].map(
          async (repo) =>
            (await repo.listNotesForPlace(place.id)).find((note) =>
              note.title?.startsWith("(conflict copy)"),
            )?.id,
        ),
      );
      expect(new Set(copyIds).size).toBe(1);
    } finally {
      a.db.close();
      b.db.close();
      fresh.db.close();
    }
  });

  it("serializes one durable HLC across repository instances sharing a device database", async () => {
    const dbName = `shared-clock-${crypto.randomUUID()}`;
    const first = new DexieRepository(dbName, { actorId: "one-device" });
    const second = new DexieRepository(dbName, { actorId: "one-device" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_753_006_400_000);
    try {
      await first.createList({
        id: "list-1",
        name: "One",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await second.createList({
        id: "list-2",
        name: "Two",
        marker: markerAt(1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await first.createList({
        id: "list-3",
        name: "Three",
        marker: markerAt(2),
        createdAt: NOW,
        updatedAt: NOW,
      });

      const stamps = (await first.db.mutationOutbox.toArray())
        .filter((job) => job.table === "lists")
        .map((job) => job.hlc)
        .sort();
      expect(stamps).toHaveLength(3);
      expect(new Set(stamps).size).toBe(3);
      expect(stamps.map((stamp) => stamp.split(":")[1])).toEqual(["000000", "000001", "000002"]);
    } finally {
      clock.mockRestore();
      first.db.close();
      second.db.close();
      await first.db.delete();
    }
  });

  it("dirties or revokes hosted output only when a pulled row actually changes state", async () => {
    const repo = device("publication-sync");
    try {
      await repo.createList({
        id: "list-1",
        name: "Before",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const publication: Publication = {
        id: "publication-1",
        target: { kind: "list", id: "list-1" },
        mode: "hosted",
        slug: "list-1",
        credentialId: "credential-1",
        status: "published",
        localRevision: "published-v1",
        lastPublishedLocalRevision: "published-v1",
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.db.publications.put(publication);
      const localRev = await repo.db.syncRevs.get("lists:list-1");
      if (!localRev?.version) throw new Error("local revision missing");
      const update = {
        table: "lists" as const,
        entityId: "list-1",
        actorId: "remote",
        hlc: "999999999999998:000000:remote",
        version: { ...localRev.version, remote: 1 },
        row: {
          id: "list-1",
          name: "Remote update",
          marker: markerAt(0),
          createdAt: NOW,
          updatedAt: LATER,
        },
      };
      expect(await repo.applyRemoteChanges([update])).toBe(true);
      const dirty = await repo.db.publications.get(publication.id);
      expect(dirty?.status).toBe("queued");
      expect((await repo.db.publicationOutbox.toArray()).map((job) => job.action)).toEqual([
        "publish",
      ]);

      const dirtyRevision = dirty?.localRevision;
      expect(await repo.applyRemoteChanges([update])).toBe(false);
      expect((await repo.db.publications.get(publication.id))?.localRevision).toBe(dirtyRevision);
      expect(await repo.db.publicationOutbox.count()).toBe(1);

      expect(
        await repo.applyRemoteChanges([
          {
            ...update,
            hlc: "999999999999999:000000:remote",
            version: { ...update.version, remote: 2 },
            row: { ...update.row, deleted: true, updatedAt: "2026-07-20T12:00:00.000Z" },
          },
        ]),
      ).toBe(true);
      expect(await repo.db.publications.get(publication.id)).toMatchObject({
        status: "revoking",
      });
      expect((await repo.db.publicationOutbox.toArray()).map((job) => job.action)).toEqual([
        "revoke",
      ]);
    } finally {
      repo.db.close();
    }
  });
});
