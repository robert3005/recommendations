/**
 * Two devices and the real sync service (spec/src/sync.md): each device is a
 * DexieRepository on fake-indexeddb, the service is the actual Hono app over
 * in-memory storage, and every byte between them goes through the same
 * key derivation, sealing and merge rules the app uses.
 */
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieRepository, type NewPlaceFacts } from "../../data/repo";
import {
  deriveKeys,
  type LibraryKeys,
  newLibraryCode,
  open,
  parseLibraryCode,
  seal,
} from "./crypto";
import { applyRemote, collectPending, syncOnce } from "./engine";
import { httpTransport, SyncError, type SyncTransport } from "./transport";

let counter = 0;
let storage: MemoryStorage;
let fetcher: typeof fetch;
let keys: LibraryKeys;
let phone: DexieRepository;
let laptop: DexieRepository;
let clock = Date.parse("2026-11-23T10:00:00.000Z");
/** A clock that only moves forward, so "later" is always later. */
const now = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

/** The repository stamps rows with the wall clock; let it tick between two devices' edits. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

const facts = (over: Partial<NewPlaceFacts> = {}): NewPlaceFacts => ({
  name: "Brat",
  lat: 51.5242,
  lng: -0.0767,
  origin: "search",
  ...over,
});

function transportFor(k: LibraryKeys): SyncTransport {
  return httpTransport(k, fetcher, "https://share.test");
}
const sync = (device: DexieRepository) => syncOnce(device.db, keys, transportFor(keys), now);

async function save(device: DexieRepository, over: Partial<NewPlaceFacts> = {}) {
  const result = await device.savePlace(facts(over), { forceNew: true });
  if (result.status !== "saved") throw new Error("not saved");
  return result.place;
}

beforeEach(async () => {
  counter += 1;
  storage = new MemoryStorage();
  const app = createShareApp({ storage });
  fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(app.request(String(input), init))) as typeof fetch;
  keys = await deriveKeys(newLibraryCode());
  await transportFor(keys).claim();
  phone = new DexieRepository(`sync-phone-${Date.now()}-${counter}`);
  laptop = new DexieRepository(`sync-laptop-${Date.now()}-${counter}`);
});

describe("the library key", () => {
  it("derives a stable id and token, and different ones per key", async () => {
    const code = newLibraryCode();
    const [a, b, other] = await Promise.all([
      deriveKeys(code),
      deriveKeys(code),
      deriveKeys(newLibraryCode()),
    ]);
    expect(a.libraryId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.libraryId).toBe(b.libraryId);
    expect(a.token).toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(other.libraryId).not.toBe(a.libraryId);
    // No derived value is the key itself or another derived value.
    expect([a.libraryId, a.token]).not.toContain(code);
  });

  it("reads a code from a pasted pairing link, and refuses anything else", () => {
    const code = newLibraryCode();
    expect(parseLibraryCode(`  ${code}\n`)).toBe(code);
    expect(parseLibraryCode(`https://app.example/settings#pair=${code}`)).toBe(code);
    expect(parseLibraryCode("not a code")).toBeUndefined();
    expect(parseLibraryCode(code.slice(1))).toBeUndefined();
  });

  it("seals rows only its own key can open", async () => {
    const record = {
      t: "views" as const,
      id: "v1",
      u: "2026-11-23T10:00:00.000Z",
      d: true as const,
    };
    const sealed = await seal(keys, record);
    expect(sealed).not.toContain("views");
    expect(await open(keys, sealed)).toEqual(record);
    expect(await open(await deriveKeys(newLibraryCode()), sealed)).toBeUndefined();
    expect(await open(keys, "AAAA")).toBeUndefined();
  });
});

describe("two devices", () => {
  it("a library built on one device arrives whole on the other", async () => {
    const list = await phone.createList("London dinners");
    const added = await phone.addToList(list.id, { kind: "new", facts: facts() });
    if (added.status !== "added") throw new Error("not added");
    await phone.updatePlacePersonal(added.place.id, {
      tags: ["date night"],
      note: "Order the turbot.",
      stars: 4.5,
      status: "been",
    });
    await phone.createView("Dates", { tags: ["date night"] });
    const post = await phone.createPost({ kind: "list", listId: list.id }, "Guide");

    const sent = await sync(phone);
    expect(sent.pushed).toBeGreaterThan(0);
    const received = await sync(laptop);
    expect(received.applied).toBe(sent.pushed);

    expect(await laptop.getPlace(added.place.id)).toMatchObject({
      name: "Brat",
      tags: ["date night"],
      note: "Order the turbot.",
      stars: 4.5,
      status: "been",
    });
    expect((await laptop.entriesOf(list.id)).map((e) => e.place.id)).toEqual([added.place.id]);
    expect(await laptop.listViews()).toMatchObject([{ name: "Dates" }]);
    expect(await laptop.getPost(post.id)).toMatchObject({ title: "Guide" });
    // Dedup indexes are rebuilt on arrival, not shipped.
    expect(await laptop.listLists()).toMatchObject([{ id: list.id, name: "London dinners" }]);
  });

  it("settles: a second cycle on each device sends nothing", async () => {
    await save(phone);
    await sync(phone);
    await sync(laptop);
    expect(await sync(phone)).toMatchObject({ applied: 0, pushed: 0 });
    expect(await sync(laptop)).toMatchObject({ applied: 0, pushed: 0 });
    expect(await collectPending(laptop.db)).toEqual([]);
  });

  it("the service holds nothing readable", async () => {
    await save(phone, { name: "A Very Recognisable Name" });
    await sync(phone);
    const rows = await storage.changesSince(keys.libraryId, 0, 100);
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("Recognisable");
    expect(dump).not.toContain("places");
  });

  it("the later edit of a row wins on both devices", async () => {
    const place = await save(phone);
    await sync(phone);
    await sync(laptop);

    await phone.updatePlacePersonal(place.id, { note: "from the phone" });
    await tick();
    await laptop.updatePlacePersonal(place.id, { note: "from the laptop, later" });
    await sync(phone);
    await sync(laptop);
    await sync(phone);

    expect((await phone.getPlace(place.id))?.note).toBe("from the laptop, later");
    expect((await laptop.getPlace(place.id))?.note).toBe("from the laptop, later");
  });

  it("tags added on each device both survive — tags merge as a set", async () => {
    const place = await save(phone);
    await sync(phone);
    await sync(laptop);

    await phone.updatePlacePersonal(place.id, { tags: ["date night"] });
    await laptop.updatePlacePersonal(place.id, { tags: ["wood fire"] });
    await sync(phone);
    await sync(laptop); // merges, and sends the merged row back
    await sync(phone);

    expect((await phone.getPlace(place.id))?.tags).toEqual(["date night", "wood fire"]);
    expect((await laptop.getPlace(place.id))?.tags).toEqual(["date night", "wood fire"]);
    // …and it stays settled.
    expect(await sync(laptop)).toMatchObject({ applied: 0, pushed: 0 });
  });

  it("a tag removed on one device is not brought back by the other's older copy", async () => {
    const place = await save(phone);
    await phone.updatePlacePersonal(place.id, { tags: ["brunch", "wine"] });
    await sync(phone);
    await sync(laptop);

    await laptop.updatePlacePersonal(place.id, { note: "an unrelated edit" });
    await tick();
    await phone.updatePlacePersonal(place.id, { tags: ["wine"] });
    await sync(laptop);
    await sync(phone);
    await sync(laptop);

    expect((await phone.getPlace(place.id))?.tags).toEqual(["wine"]);
    expect((await laptop.getPlace(place.id))?.tags).toEqual(["wine"]);
  });

  it("a deletion travels, with the entries that went with it", async () => {
    const list = await phone.createList("Lisbon");
    const added = await phone.addToList(list.id, { kind: "new", facts: facts() });
    if (added.status !== "added") throw new Error("not added");
    await sync(phone);
    await sync(laptop);
    expect(await laptop.getPlace(added.place.id)).toBeDefined();

    await phone.deletePlace(added.place.id);
    await sync(phone);
    await sync(laptop);

    expect(await laptop.getPlace(added.place.id)).toBeUndefined();
    expect(await laptop.entriesOf(list.id)).toEqual([]);
    // The list itself was not deleted.
    expect(await laptop.getList(list.id)).toBeDefined();
    // Nothing comes back on the next round.
    await sync(phone);
    expect(await phone.getPlace(added.place.id)).toBeUndefined();
  });

  it("deleting a list on one device keeps its places on both", async () => {
    const list = await phone.createList("Lisbon");
    const added = await phone.addToList(list.id, { kind: "new", facts: facts() });
    if (added.status !== "added") throw new Error("not added");
    await sync(phone);
    await sync(laptop);

    await laptop.deleteList(list.id);
    await sync(laptop);
    await sync(phone);

    expect(await phone.getList(list.id)).toBeUndefined();
    expect(await phone.getPlace(added.place.id)).toBeDefined();
    expect((await phone.listPlaceViews())[0]?.listIds).toEqual([]);
  });

  it("an edit made after a deletion elsewhere brings the row back everywhere", async () => {
    const place = await save(phone);
    await sync(phone);
    await sync(laptop);

    await phone.deletePlace(place.id);
    await tick();
    await laptop.updatePlacePersonal(place.id, { note: "still want this" }); // later than the delete
    await sync(phone);
    await sync(laptop);
    await sync(phone);

    expect((await phone.getPlace(place.id))?.note).toBe("still want this");
    expect((await laptop.getPlace(place.id))?.note).toBe("still want this");
  });

  it("the same place put on the same list on both devices ends as one entry", async () => {
    const list = await phone.createList("Lisbon");
    const place = await save(phone);
    await sync(phone);
    await sync(laptop);

    await phone.addToList(list.id, { kind: "existing", placeId: place.id });
    await laptop.addToList(list.id, { kind: "existing", placeId: place.id });
    await sync(phone);
    await sync(laptop);
    await sync(phone);
    await sync(laptop);

    const onPhone = await phone.entriesOf(list.id);
    const onLaptop = await laptop.entriesOf(list.id);
    expect(onPhone).toHaveLength(1);
    expect(onLaptop.map((e) => e.entry.id)).toEqual(onPhone.map((e) => e.entry.id));
  });

  it("a device that holds a page's editor token keeps it", async () => {
    const list = await phone.createList("Lisbon");
    const publication = await phone.createPublication(
      { kind: "list", id: list.id },
      "lisbon",
      "t".repeat(43),
      now(),
    );
    await sync(phone);
    await sync(laptop);
    // The token travels sealed, so the second device can update the page too.
    expect((await laptop.publicationFor({ kind: "list", id: list.id }))?.editorToken).toBe(
      "t".repeat(43),
    );
    expect(publication.editorToken).toBe("t".repeat(43));
    const dump = JSON.stringify(await storage.changesSince(keys.libraryId, 0, 100));
    expect(dump).not.toContain("t".repeat(43));
  });

  it("a device joining with places of its own keeps them and sends them", async () => {
    await save(phone, { name: "Phone place" });
    await save(laptop, { name: "Laptop place", lat: 48.85, lng: 2.35 });
    await sync(phone);
    await sync(laptop);
    await sync(phone);
    const names = (repo: DexieRepository) =>
      repo.listPlaceViews().then((views) => views.map((v) => v.place.name).sort());
    expect(await names(phone)).toEqual(["Laptop place", "Phone place"]);
    expect(await names(laptop)).toEqual(["Laptop place", "Phone place"]);
  });
});

describe("failure", () => {
  it("a key for a library that does not exist is a clear answer", async () => {
    const stranger = await deriveKeys(newLibraryCode());
    await expect(syncOnce(phone.db, stranger, transportFor(stranger), now)).rejects.toMatchObject({
      reason: "no-library",
    });
  });

  it("an unreachable service loses nothing: the rows are still waiting", async () => {
    await save(phone);
    const offline = httpTransport(
      keys,
      (() => Promise.reject(new TypeError("network"))) as typeof fetch,
      "https://share.test",
    );
    await expect(syncOnce(phone.db, keys, offline, now)).rejects.toBeInstanceOf(SyncError);
    expect((await collectPending(phone.db)).length).toBe(1);
    // Back online, the same rows go.
    expect((await sync(phone)).pushed).toBe(1);
  });

  it("skips a row it cannot open instead of trusting it", async () => {
    await storage.putRows(keys.libraryId, [
      { k: "f".repeat(64), c: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" },
    ]);
    const summary = await sync(laptop);
    expect(summary).toMatchObject({ pulled: 1, applied: 0 });
    expect(await laptop.listPlaceViews()).toEqual([]);
  });
});

describe("rows from a build before five-star ratings", () => {
  it("a three-step rating and a minRating view arrive as stars", async () => {
    const at = "2026-11-23T09:00:00.000Z";
    const applied = await applyRemote(
      laptop.db,
      [
        {
          t: "places",
          id: "old-place",
          u: at,
          row: {
            id: "old-place",
            name: "Brat",
            lat: 51.52,
            lng: -0.07,
            origin: "search",
            rating: 2,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          t: "views",
          id: "old-view",
          u: at,
          row: {
            id: "old-view",
            name: "Best",
            marker: { shape: "star", color: "#111111" },
            filter: { minRating: 3 },
            createdAt: at,
            updatedAt: at,
          },
        },
      ],
      now(),
    );
    expect(applied).toBe(2);
    const place = await laptop.getPlace("old-place");
    expect(place?.stars).toBe(4);
    expect(place).not.toHaveProperty("rating");
    expect(await laptop.listViews()).toMatchObject([{ filter: { minStars: 5 } }]);
  });
});
