/**
 * A pre-refocus dev database must never crash the app: opening one flushes it
 * (db.ts version 2 upgrade). The old build's rows — e.g. a list whose marker
 * is `{color, icon}` or missing entirely — took the home page down with
 * "can't access property 'shape', marker is undefined".
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PlacemarksDb } from "./db";

let counter = 0;
let name = "";

/** Recreate the old build's database: Dexie version(1) = IndexedDB version 10. */
function seedOldDatabase(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 10);
    open.onupgradeneeded = () => {
      const db = open.result;
      const lists = db.createObjectStore("lists", { keyPath: "id" });
      db.createObjectStore("places", { keyPath: "id" });
      db.createObjectStore("notes", { keyPath: "id" }); // old-build-only store
      lists.transaction.oncomplete = () => undefined;
      // Old marker shape: {color, icon} — no `shape`. Another row has none at all.
      lists.put({ id: "old-1", name: "Old list", marker: { color: "#1f6f43", icon: "star" } });
      lists.put({ id: "old-2", name: "Older list", color: "#aa3311" });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
}

beforeEach(() => {
  counter += 1;
  name = `stale-db-${Date.now()}-${counter}`;
});

describe("stale dev database", () => {
  it("opening flushes old rows and provides every new store", async () => {
    await seedOldDatabase(name);

    const db = new PlacemarksDb(name);
    await db.open();

    // Old-shape rows are gone — nothing can reach a marker without a shape.
    expect(await db.lists.toArray()).toEqual([]);
    expect(await db.places.toArray()).toEqual([]);
    // Stores the old build never had exist and work.
    await db.settings.put({ key: "probe", value: 1 });
    expect((await db.settings.get("probe"))?.value).toBe(1);
    await db.listEntries.put({
      id: "e1",
      listId: "l1",
      placeId: "p1",
      rank: "a",
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    expect(await db.listEntries.count()).toBe(1);
    db.close();
  });

  it("a fresh database opens straight at the current version", async () => {
    const db = new PlacemarksDb(name);
    await db.open();
    expect(await db.lists.count()).toBe(0);
    await db.lists.put({
      id: "l1",
      name: "New list",
      marker: { shape: "circle", color: "#F97316" },
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    expect((await db.lists.get("l1"))?.marker.shape).toBe("circle");
    db.close();
  });
});
