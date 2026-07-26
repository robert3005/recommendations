/**
 * DexieRepository invariants (spec/src/storage.md §Repository invariants) on
 * fake-indexeddb: membership is existence, the dedup precedence ladder, marker
 * uniqueness up to the 64-pair space, the three teardown refusals, post-target
 * immutability, and the id-preserving library archive round trip.
 */
import type { List, ListEntry, Place, Post, Publication } from "@placemarks/domain";
import { markerKey, rankBetween } from "@placemarks/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AddResult,
  DexieRepository,
  type LibraryArchive,
  type NewPlaceFacts,
  TeardownRefusedError,
} from "./repo";

const NOW = "2026-07-26T12:00:00.000Z";
const LATER = "2026-07-26T13:00:00.000Z";

let repo: DexieRepository;
let counter = 0;

beforeEach(() => {
  counter += 1;
  repo = new DexieRepository(`test-db-${Date.now()}-${counter}`);
});

function facts(overrides: Partial<NewPlaceFacts> = {}): NewPlaceFacts {
  return { name: "Café Central", lat: 38.7139, lng: -9.1394, origin: "search", ...overrides };
}

/** Narrow an AddResult that must not be a conflict. */
function placeOf(result: AddResult): Place {
  if (result.status === "name-proximity-conflict") {
    throw new Error("unexpected name-proximity conflict");
  }
  return result.place;
}

async function refusal(action: Promise<unknown>): Promise<TeardownRefusedError> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TeardownRefusedError);
  return error as TeardownRefusedError;
}

const GOOGLE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/@38.71,-9.14,17z/data=!3d38.7139!4d-9.1394!1s0x1a2b3c:0x4d5e6f";

describe("membership is existence", () => {
  it("a place enters the library by being added to a list", async () => {
    const list = await repo.createList("Lisbon");
    const result = await repo.addToList(list.id, { kind: "new", facts: facts() }, { now: NOW });
    expect(result.status).toBe("added");
    const views = await repo.listPlaceViews();
    expect(views).toHaveLength(1);
    expect(views[0]?.listIds).toEqual([list.id]);
    expect(views[0]?.place.createdAt).toBe(NOW);
  });

  it("an existing place joins another list without forking identity", async () => {
    const l1 = await repo.createList("Lisbon");
    const l2 = await repo.createList("Coffee");
    const place = placeOf(await repo.addToList(l1.id, { kind: "new", facts: facts() }));
    const again = await repo.addToList(l2.id, { kind: "existing", placeId: place.id });
    expect(again.status).toBe("added");
    expect(placeOf(again).id).toBe(place.id);
    const views = await repo.listPlaceViews();
    expect(views).toHaveLength(1);
    expect(views[0]?.listIds.sort()).toEqual([l1.id, l2.id].sort());
  });

  it("a place appears at most once per list — re-adding reports already-member", async () => {
    const list = await repo.createList("Lisbon");
    const place = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));
    const again = await repo.addToList(list.id, { kind: "existing", placeId: place.id });
    expect(again.status).toBe("already-member");
    expect(await repo.entriesOf(list.id)).toHaveLength(1);
  });

  it("removing one of several memberships keeps the place; the last removes it", async () => {
    const l1 = await repo.createList("Lisbon");
    const l2 = await repo.createList("Coffee");
    const place = placeOf(await repo.addToList(l1.id, { kind: "new", facts: facts() }));
    await repo.addToList(l2.id, { kind: "existing", placeId: place.id });

    const l1Entry = (await repo.entriesOf(l1.id))[0]?.entry;
    if (!l1Entry) throw new Error("no entry");
    await repo.removeEntry(l1Entry.id);
    expect(await repo.getPlace(place.id)).toBeDefined();

    const l2Entry = (await repo.entriesOf(l2.id))[0]?.entry;
    if (!l2Entry) throw new Error("no entry");
    await repo.removeEntry(l2Entry.id);
    expect(await repo.getPlace(place.id)).toBeUndefined();
    expect(await repo.listPlaceViews()).toHaveLength(0);
  });

  it("entries order by (rank, id) and moveEntry reorders", async () => {
    const list = await repo.createList("Lisbon");
    const a = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts({ name: "A" }) }));
    const b = placeOf(
      await repo.addToList(list.id, {
        kind: "new",
        facts: facts({ name: "B", lat: 38.72, lng: -9.15 }),
      }),
    );
    const c = placeOf(
      await repo.addToList(list.id, {
        kind: "new",
        facts: facts({ name: "C", lat: 38.73, lng: -9.16 }),
      }),
    );
    let order = (await repo.entriesOf(list.id)).map((v) => v.place.id);
    expect(order).toEqual([a.id, b.id, c.id]);

    const entries = await repo.entriesOf(list.id);
    const cEntry = entries[2]?.entry;
    const aEntry = entries[0]?.entry;
    if (!cEntry || !aEntry) throw new Error("missing entries");
    await repo.moveEntry(cEntry.id, aEntry.id); // C before A
    order = (await repo.entriesOf(list.id)).map((v) => v.place.id);
    expect(order).toEqual([c.id, a.id, b.id]);

    await repo.moveEntry(cEntry.id, null); // C to the end
    order = (await repo.entriesOf(list.id)).map((v) => v.place.id);
    expect(order).toEqual([a.id, b.id, c.id]);
  });

  it("updatePlaceFacts edits the user's copy and refuses impossible coordinates", async () => {
    const list = await repo.createList("Lisbon");
    const place = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));
    await repo.updatePlaceFacts(place.id, { name: "Café Central (renamed)", category: "cafe" });
    const updated = await repo.getPlace(place.id);
    expect(updated?.name).toBe("Café Central (renamed)");
    expect(updated?.category).toBe("cafe");
    await expect(repo.updatePlaceFacts(place.id, { lat: 91 })).rejects.toThrow(/coordinates/);
  });

  it("updatePlaceFacts accepts the richer POI facts and leaves unpatched ones alone", async () => {
    const list = await repo.createList("Lisbon");
    const place = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));
    await repo.updatePlaceFacts(place.id, {
      website: "https://cafecentral.pt",
      phone: "+351 21 000 0000",
      openingHours: "Mo-Fr 08:00-18:00",
      cuisine: "portuguese",
      wheelchair: "limited",
      description: "Historic café.",
      descriptionSource: "osm",
      wikipediaUrl: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)",
    });
    const updated = await repo.getPlace(place.id);
    expect(updated).toMatchObject({
      website: "https://cafecentral.pt",
      phone: "+351 21 000 0000",
      openingHours: "Mo-Fr 08:00-18:00",
      cuisine: "portuguese",
      wheelchair: "limited",
      description: "Historic café.",
      descriptionSource: "osm",
      wikipediaUrl: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)",
    });
    // A later unrelated patch leaves the facts standing.
    await repo.updatePlaceFacts(place.id, { name: "Café Central (renamed)" });
    expect((await repo.getPlace(place.id))?.website).toBe("https://cafecentral.pt");
  });
});

describe("dedup precedence: feature id → osmRef → name + proximity", () => {
  it("dedups by Google feature id and keeps the user's facts", async () => {
    const l1 = await repo.createList("Lisbon");
    const l2 = await repo.createList("Coffee");
    const place = placeOf(
      await repo.addToList(l1.id, { kind: "new", facts: facts({ googleUrl: GOOGLE_URL }) }),
    );
    // Same listing pasted later: different camera, truncated name.
    const result = await repo.addToList(l2.id, {
      kind: "new",
      facts: facts({
        name: "Central",
        lat: 38.7141,
        lng: -9.1391,
        googleUrl: "https://maps.google.com/maps?cid=1&q=x&ftid=0x1a2b3c:0x4d5e6f",
      }),
    });
    expect(result.status).toBe("added");
    expect(placeOf(result).id).toBe(place.id);
    expect(placeOf(result).name).toBe("Café Central"); // facts are the user's copy
    expect(await repo.listPlaceViews()).toHaveLength(1);
  });

  it("dedups by osmRef", async () => {
    const l1 = await repo.createList("Lisbon");
    const l2 = await repo.createList("Coffee");
    const ref = { type: "node" as const, id: "101" };
    const place = placeOf(
      await repo.addToList(l1.id, { kind: "new", facts: facts({ osmRef: ref, origin: "osm" }) }),
    );
    const result = await repo.addToList(l2.id, {
      kind: "new",
      facts: facts({ name: "Different name", osmRef: ref, origin: "osm" }),
    });
    expect(placeOf(result).id).toBe(place.id);
    expect(await repo.findByOsmRef(ref)).toBeDefined();
  });

  it("feature id outranks osmRef", async () => {
    const l1 = await repo.createList("Lisbon");
    const byFeature = placeOf(
      await repo.addToList(l1.id, {
        kind: "new",
        facts: facts({ googleUrl: GOOGLE_URL, osmRef: { type: "node", id: "101" } }),
      }),
    );
    const byRef = placeOf(
      await repo.addToList(l1.id, {
        kind: "new",
        facts: facts({ name: "Other", lat: 40, lng: -8, osmRef: { type: "node", id: "202" } }),
      }),
    );
    // Carries byFeature's feature id AND byRef's osmRef: the feature id wins.
    const l2 = await repo.createList("Coffee");
    const result = await repo.addToList(l2.id, {
      kind: "new",
      facts: facts({ googleUrl: GOOGLE_URL, osmRef: { type: "node", id: "202" } }),
    });
    expect(placeOf(result).id).toBe(byFeature.id);
    expect(placeOf(result).id).not.toBe(byRef.id);
  });

  it("osmRef outranks name + proximity", async () => {
    const l1 = await repo.createList("Lisbon");
    const byRef = placeOf(
      await repo.addToList(l1.id, {
        kind: "new",
        facts: facts({ name: "Tasca", lat: 40, lng: -8, osmRef: { type: "node", id: "301" } }),
      }),
    );
    placeOf(
      await repo.addToList(
        l1.id,
        { kind: "new", facts: facts({ name: "Tasca", lat: 38.7139, lng: -9.1394 }) },
        { forceNew: true },
      ),
    );
    // Same name right next to the second place, but the ref names the first.
    const l2 = await repo.createList("Coffee");
    const result = await repo.addToList(l2.id, {
      kind: "new",
      facts: facts({
        name: "Tasca",
        lat: 38.7139,
        lng: -9.1394,
        osmRef: { type: "node", id: "301" },
      }),
    });
    expect(placeOf(result).id).toBe(byRef.id);
  });

  it("name + proximity prompts instead of merging silently, then honours the user's answer", async () => {
    const list = await repo.createList("Lisbon");
    const existing = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));

    // Same normalised name ~30 m away → conflict, nothing written.
    const conflict = await repo.addToList(list.id, {
      kind: "new",
      facts: facts({ name: "café central!", lat: 38.71415, lng: -9.1394 }),
    });
    expect(conflict.status).toBe("name-proximity-conflict");
    if (conflict.status !== "name-proximity-conflict") throw new Error("unreachable");
    expect(conflict.existing.id).toBe(existing.id);
    expect(await repo.listPlaceViews()).toHaveLength(1);

    // "Same place" → retry as existing.
    const same = await repo.addToList(list.id, { kind: "existing", placeId: existing.id });
    expect(same.status).toBe("already-member");

    // "No, it is new" → forceNew skips only the prompt rung.
    const fresh = await repo.addToList(
      list.id,
      { kind: "new", facts: facts({ name: "café central!", lat: 38.71415, lng: -9.1394 }) },
      { forceNew: true },
    );
    expect(fresh.status).toBe("added");
    expect(placeOf(fresh).id).not.toBe(existing.id);
    expect(await repo.listPlaceViews()).toHaveLength(2);
  });

  it("the same name far away is a different place, no prompt", async () => {
    const list = await repo.createList("Lisbon");
    const first = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));
    const result = await repo.addToList(list.id, {
      kind: "new",
      facts: facts({ lat: 41.15, lng: -8.61 }), // Porto
    });
    expect(result.status).toBe("added");
    expect(placeOf(result).id).not.toBe(first.id);
  });

  it("a dedup hit fills in missing provenance refs without touching facts", async () => {
    const l1 = await repo.createList("Lisbon");
    const place = placeOf(
      await repo.addToList(l1.id, { kind: "new", facts: facts({ googleUrl: GOOGLE_URL }) }),
    );
    expect(place.appleUrl).toBeUndefined();
    const result = await repo.addToList(l1.id, {
      kind: "new",
      facts: facts({
        googleUrl: GOOGLE_URL,
        appleUrl: "https://maps.apple.com/?ll=38.7139,-9.1394&q=Caf%C3%A9%20Central",
        osmRef: { type: "node", id: "101" },
      }),
    });
    expect(result.status).toBe("already-member");
    const merged = await repo.getPlace(place.id);
    expect(merged?.appleUrl).toContain("maps.apple.com");
    expect(merged?.osmRef).toEqual({ type: "node", id: "101" });
    expect(merged?.name).toBe("Café Central");
  });

  it("imageUrl rides new-place facts and a dedup hit fills a missing one", async () => {
    const IMAGE = "https://commons.wikimedia.org/wiki/Special:FilePath/Central.jpg?width=640";
    const list = await repo.createList("Lisbon");
    const bare = placeOf(
      await repo.addToList(list.id, {
        kind: "new",
        facts: facts({ osmRef: { type: "node", id: "101" } }),
      }),
    );
    expect(bare.imageUrl).toBeUndefined();

    // The osmRef dedup hit fills the missing photo like the other provenance refs.
    await repo.addToList(list.id, {
      kind: "new",
      facts: facts({ osmRef: { type: "node", id: "101" }, imageUrl: IMAGE }),
    });
    expect((await repo.getPlace(bare.id))?.imageUrl).toBe(IMAGE);

    // A place born with one keeps it, and updatePlaceFacts can write it later.
    const born = placeOf(
      await repo.addToList(list.id, {
        kind: "new",
        facts: facts({ name: "Café do Rio", lat: 38.71, lng: -9.142, imageUrl: IMAGE }),
      }),
    );
    expect(born.imageUrl).toBe(IMAGE);
    await repo.updatePlaceFacts(bare.id, { imageUrl: `${IMAGE}&later` });
    expect((await repo.getPlace(bare.id))?.imageUrl).toBe(`${IMAGE}&later`);
  });
});

describe("markers", () => {
  it("auto-assigns unique pairs and honours preferColor", async () => {
    const first = await repo.createList("One");
    expect(markerKey(first.marker)).toBe("circle:#F97316");
    const second = await repo.createList("Two");
    expect(markerKey(second.marker)).toBe("diamond:#2457E6");
    // Orange circle is taken, so the preferred colour walks to its next free shape.
    const preferred = await repo.createList("Three", { preferColor: "#F97316" });
    expect(preferred.marker.color).toBe("#F97316");
    expect(preferred.marker.shape).not.toBe("circle");
  });

  it("refuses a manual swap onto a worn pair and allows a free one", async () => {
    const l1 = await repo.createList("One");
    const l2 = await repo.createList("Two");
    await expect(repo.setListMarker(l2.id, l1.marker)).rejects.toThrow(/worn/);
    await repo.setListMarker(l2.id, { shape: "star", color: "#7C3AED" });
    expect(markerKey((await repo.getList(l2.id))?.marker ?? l2.marker)).toBe("star:#7C3AED");
  });

  it("keeps 64 live lists unique, then repeats pairs deterministically", async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const list = await repo.createList(`List ${i}`);
      keys.add(markerKey(list.marker));
    }
    expect(keys.size).toBe(64);
    const beyond = await repo.createList("List 64");
    expect(keys.has(markerKey(beyond.marker))).toBe(true);
  });
});

describe("teardown refusals", () => {
  it("refuses the last-membership removal while posts target the place", async () => {
    const list = await repo.createList("Lisbon");
    const place = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));
    const post = await repo.createPost({ kind: "place", placeId: place.id }, "Café Central");

    const entry = (await repo.entriesOf(list.id))[0]?.entry;
    if (!entry) throw new Error("no entry");
    const error = await refusal(repo.removeEntry(entry.id));
    expect(error.blockers).toEqual([{ kind: "place-has-posts", ids: [post.id] }]);
    expect(await repo.getPlace(place.id)).toBeDefined();

    await repo.deletePost(post.id);
    await repo.removeEntry(entry.id);
    expect(await repo.getPlace(place.id)).toBeUndefined();
  });

  it("place posts do not block removal while another membership remains", async () => {
    const l1 = await repo.createList("Lisbon");
    const l2 = await repo.createList("Coffee");
    const place = placeOf(await repo.addToList(l1.id, { kind: "new", facts: facts() }));
    await repo.addToList(l2.id, { kind: "existing", placeId: place.id });
    await repo.createPost({ kind: "place", placeId: place.id }, "Write-up");

    const entry = (await repo.entriesOf(l1.id))[0]?.entry;
    if (!entry) throw new Error("no entry");
    await repo.removeEntry(entry.id);
    expect(await repo.getPlace(place.id)).toBeDefined();
  });

  it("refuses to delete a list until it is empty and its posts are deleted", async () => {
    const list = await repo.createList("Lisbon");
    const place = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));
    const post = await repo.createPost({ kind: "list", listId: list.id }, "Guide");

    const error = await refusal(repo.deleteList(list.id));
    expect(error.blockers).toEqual([
      { kind: "list-not-empty", ids: [place.id] },
      { kind: "list-has-posts", ids: [post.id] },
    ]);

    const entry = (await repo.entriesOf(list.id))[0]?.entry;
    if (!entry) throw new Error("no entry");
    await repo.removeEntry(entry.id);
    await repo.deletePost(post.id);
    await repo.deleteList(list.id);
    expect(await repo.getList(list.id)).toBeUndefined();
  });

  it("refuses to delete a list with a live publication until it is unpublished", async () => {
    const list = await repo.createList("Lisbon");
    const publication = await repo.createPublication(
      { kind: "list", id: list.id },
      "lisbon",
      "secret-token",
      NOW,
    );
    const error = await refusal(repo.deleteList(list.id));
    expect(error.blockers).toEqual([{ kind: "live-publication", ids: [publication.id] }]);

    await repo.markRevoked(publication.id, LATER);
    await repo.deleteList(list.id); // a revoked tombstone no longer blocks
    expect(await repo.getList(list.id)).toBeUndefined();
  });

  it("refuses to delete a published post until it is unpublished", async () => {
    const list = await repo.createList("Lisbon");
    const post = await repo.createPost({ kind: "list", listId: list.id }, "Guide");
    const publication = await repo.createPublication(
      { kind: "post", id: post.id },
      "guide",
      "secret-token",
      NOW,
    );
    const error = await refusal(repo.deletePost(post.id));
    expect(error.blockers).toEqual([{ kind: "live-publication", ids: [publication.id] }]);

    await repo.markRevoked(publication.id, LATER);
    await repo.deletePost(post.id);
    expect(await repo.getPost(post.id)).toBeUndefined();
  });
});

describe("posts", () => {
  it("refuses creation when the target does not exist", async () => {
    await expect(repo.createPost({ kind: "list", listId: "nope" }, "Guide")).rejects.toThrow(
      /target/,
    );
    await expect(repo.createPost({ kind: "place", placeId: "nope" }, "Note")).rejects.toThrow(
      /target/,
    );
  });

  it("finds posts by target and lists all posts", async () => {
    const list = await repo.createList("Lisbon");
    const place = placeOf(await repo.addToList(list.id, { kind: "new", facts: facts() }));
    const listPost = await repo.createPost({ kind: "list", listId: list.id }, "Guide");
    const placePost = await repo.createPost({ kind: "place", placeId: place.id }, "Café");

    expect((await repo.postsFor({ kind: "list", listId: list.id })).map((p) => p.id)).toEqual([
      listPost.id,
    ]);
    expect((await repo.postsFor({ kind: "place", placeId: place.id })).map((p) => p.id)).toEqual([
      placePost.id,
    ]);
    expect(await repo.allPosts()).toHaveLength(2);
  });

  it("updates title and body only — the target is immutable after creation", async () => {
    const list = await repo.createList("Lisbon");
    const post = await repo.createPost({ kind: "list", listId: list.id }, "Guide");
    await repo.updatePost(post.id, { title: "The Guide", body: "Start at [x](place:abc)." });
    const updated = await repo.getPost(post.id);
    expect(updated?.title).toBe("The Guide");
    expect(updated?.body).toContain("place:abc");
    // No update path exists for the target; it is exactly what creation set.
    expect(updated?.target).toEqual({ kind: "list", listId: list.id });
  });
});

describe("publications", () => {
  it("records first publish, tracks the published hash, and revokes once", async () => {
    const list = await repo.createList("Lisbon");
    const publication = await repo.createPublication(
      { kind: "list", id: list.id },
      "lisbon",
      "secret-token",
      NOW,
    );
    await repo.recordPublished(publication.id, "hash-1", NOW);
    let row = await repo.publicationFor({ kind: "list", id: list.id });
    expect(row?.lastPublishedHash).toBe("hash-1");
    expect(row?.publishedAt).toBe(NOW);
    expect(row?.editorToken).toBe("secret-token");

    await repo.markRevoked(publication.id, LATER);
    await repo.markRevoked(publication.id, "2026-07-26T14:00:00.000Z");
    row = await repo.publicationFor({ kind: "list", id: list.id });
    expect(row?.revokedAt).toBe(LATER); // the tombstone keeps its first revocation
    expect(await repo.livePublications()).toHaveLength(0);
  });

  it("publishing again after a revoke is a new publication under a new slug", async () => {
    const list = await repo.createList("Lisbon");
    const first = await repo.createPublication(
      { kind: "list", id: list.id },
      "lisbon",
      "token-1",
      NOW,
    );
    await repo.markRevoked(first.id, NOW);
    const second = await repo.createPublication(
      { kind: "list", id: list.id },
      "lisbon-2",
      "token-2",
      LATER,
    );
    const latest = await repo.publicationFor({ kind: "list", id: list.id });
    expect(latest?.id).toBe(second.id);
    expect((await repo.livePublications()).map((p) => p.id)).toEqual([second.id]);
  });
});

describe("import working state", () => {
  it("persists batches and items across status changes", async () => {
    await repo.createImportBatch({
      id: "b1",
      source: "takeout",
      fileName: "takeout.zip",
      startedAt: NOW,
      status: "reviewing",
    });
    await repo.putImportItems([
      { id: "i1", batchId: "b1", targetListId: "l1", raw: { title: "Row 1" }, status: "review" },
      { id: "i2", batchId: "b1", targetListId: "l1", raw: { title: "Row 2" }, status: "placed" },
      { id: "i3", batchId: "other", targetListId: "l2", raw: { title: "X" }, status: "skipped" },
    ]);
    expect((await repo.itemsOf("b1")).map((i) => i.id)).toEqual(["i1", "i2"]);

    await repo.updateImportItem({
      id: "i1",
      batchId: "b1",
      targetListId: "l1",
      raw: { title: "Row 1" },
      status: "skipped",
    });
    expect((await repo.itemsOf("b1"))[0]?.status).toBe("skipped");

    await repo.setBatchStatus("b1", "done");
    expect((await repo.getImportBatch("b1"))?.status).toBe("done");
    expect((await repo.listImportBatches()).map((b) => b.id)).toEqual(["b1"]);
  });
});

describe("settings", () => {
  it("round-trips small key-value state", async () => {
    expect(await repo.getSetting("viewport")).toBeUndefined();
    await repo.setSetting("viewport", { lng: -9.14, lat: 38.72, zoom: 12 });
    expect(await repo.getSetting<{ zoom: number }>("viewport")).toEqual({
      lng: -9.14,
      lat: 38.72,
      zoom: 12,
    });
    await repo.setSetting("viewport", { lng: 0, lat: 0, zoom: 1 });
    expect((await repo.getSetting<{ zoom: number }>("viewport"))?.zoom).toBe(1);
  });
});

describe("library archive", () => {
  /** A small but complete library: shared place, posts, live + revoked publications. */
  async function seedLibrary() {
    const lisbon = await repo.createList("Lisbon");
    const coffee = await repo.createList("Coffee");
    const cafe = placeOf(
      await repo.addToList(
        lisbon.id,
        { kind: "new", facts: facts({ googleUrl: GOOGLE_URL }) },
        { now: NOW },
      ),
    );
    await repo.addToList(coffee.id, { kind: "existing", placeId: cafe.id }, { now: NOW });
    const tasca = placeOf(
      await repo.addToList(
        lisbon.id,
        {
          kind: "new",
          facts: facts({
            name: "Tasca",
            lat: 38.72,
            lng: -9.15,
            osmRef: { type: "node", id: "9" },
          }),
        },
        { now: NOW },
      ),
    );
    const listPost = await repo.createPost({ kind: "list", listId: lisbon.id }, "Guide");
    await repo.updatePost(listPost.id, { body: `See [Café](place:${cafe.id}).` });
    const placePost = await repo.createPost({ kind: "place", placeId: tasca.id }, "Tasca");
    const livePub = await repo.createPublication(
      { kind: "list", id: lisbon.id },
      "lisbon",
      "list-token",
      NOW,
    );
    await repo.recordPublished(livePub.id, "hash-live", NOW);
    const revokedPub = await repo.createPublication(
      { kind: "post", id: listPost.id },
      "guide",
      "post-token",
      NOW,
    );
    await repo.markRevoked(revokedPub.id, NOW);
    return { lisbon, coffee, cafe, tasca, listPost, placePost, livePub, revokedPub };
  }

  it("strips editor tokens by default and keeps them under the explicit opt-in", async () => {
    await seedLibrary();
    const routine = await repo.exportLibrary({ includeCredentials: false });
    expect(routine.publications).toHaveLength(2);
    for (const publication of routine.publications) {
      expect(publication.editorToken).toBeUndefined();
      expect(publication.slug).toBeTruthy(); // slugs are public anyway
    }
    const credentialed = await repo.exportLibrary({ includeCredentials: true });
    expect(credentialed.publications.map((p) => p.editorToken).sort()).toEqual([
      "list-token",
      "post-token",
    ]);
  });

  it("exports domain shapes, not rows — derived index fields never leak", async () => {
    await seedLibrary();
    const archive = await repo.exportLibrary({ includeCredentials: false });
    for (const place of archive.places) {
      expect("googleFeatureId" in place).toBe(false);
      expect("osmKey" in place).toBe(false);
    }
    for (const post of archive.posts) expect("targetKey" in post).toBe(false);
    for (const publication of archive.publications) {
      expect("targetKey" in publication).toBe(false);
    }
  });

  it("round-trips into an empty library preserving every id", async () => {
    const seeded = await seedLibrary();
    const archive = await repo.exportLibrary({ includeCredentials: true });

    counter += 1;
    const restored = new DexieRepository(`test-db-${Date.now()}-${counter}`);
    expect((await restored.importLibrary(archive)).mode).toBe("fresh");

    const views = await restored.listPlaceViews();
    expect(views.map((v) => v.place.id).sort()).toEqual([seeded.cafe.id, seeded.tasca.id].sort());
    expect((await restored.entriesOf(seeded.lisbon.id)).map((v) => v.place.id)).toEqual([
      seeded.cafe.id,
      seeded.tasca.id,
    ]);
    // place:/post: joins survive because ids do.
    expect((await restored.getPost(seeded.listPost.id))?.body).toContain(seeded.cafe.id);
    expect(
      (await restored.postsFor({ kind: "place", placeId: seeded.tasca.id })).map((p) => p.id),
    ).toEqual([seeded.placePost.id]);
    // Publication state travelled, including the revoked tombstone.
    expect((await restored.livePublications()).map((p) => p.id)).toEqual([seeded.livePub.id]);
    const tombstone = await restored.publicationFor({ kind: "post", id: seeded.listPost.id });
    expect(tombstone?.revokedAt).toBe(NOW);
    expect(tombstone?.editorToken).toBe("post-token");
  });

  it("a credential-less restore sees its publications but holds no tokens", async () => {
    const seeded = await seedLibrary();
    const archive = await repo.exportLibrary({ includeCredentials: false });

    counter += 1;
    const restored = new DexieRepository(`test-db-${Date.now()}-${counter}`);
    await restored.importLibrary(archive);
    const publication = await restored.publicationFor({ kind: "list", id: seeded.lisbon.id });
    expect(publication?.slug).toBe("lisbon");
    expect(publication?.editorToken).toBeUndefined();
  });

  it("re-importing the same archive converges — merge changes nothing", async () => {
    await seedLibrary();
    const archive = await repo.exportLibrary({ includeCredentials: true });
    expect((await repo.importLibrary(archive, LATER)).mode).toBe("merge");
    const after = await repo.exportLibrary({ includeCredentials: true });
    expect(after.places).toEqual(archive.places);
    expect(after.lists).toEqual(archive.lists);
    expect(after.listEntries).toEqual(archive.listEntries);
    expect(after.posts).toEqual(archive.posts);
    expect(after.publications).toEqual(archive.publications);
  });

  it("merges by id with newer updatedAt winning in both directions", async () => {
    const seeded = await seedLibrary();
    const archive = await repo.exportLibrary({ includeCredentials: true });

    const newer = structuredClone(archive);
    const newerPlace = newer.places.find((p) => p.id === seeded.cafe.id);
    if (!newerPlace) throw new Error("place missing from archive");
    newerPlace.name = "Café Central (from the other device)";
    newerPlace.updatedAt = "2026-07-27T00:00:00.000Z";
    await repo.importLibrary(newer, LATER);
    expect((await repo.getPlace(seeded.cafe.id))?.name).toBe(
      "Café Central (from the other device)",
    );

    const older = structuredClone(archive);
    const olderPlace = older.places.find((p) => p.id === seeded.cafe.id);
    if (!olderPlace) throw new Error("place missing from archive");
    olderPlace.name = "Stale name";
    olderPlace.updatedAt = "2026-07-01T00:00:00.000Z";
    await repo.importLibrary(older, LATER);
    expect((await repo.getPlace(seeded.cafe.id))?.name).toBe(
      "Café Central (from the other device)",
    );
  });

  it("a winning credential-less publication row never erases a held token", async () => {
    const seeded = await seedLibrary();
    const archive = await repo.exportLibrary({ includeCredentials: false });
    const pub = archive.publications.find((p) => p.id === seeded.livePub.id);
    if (!pub) throw new Error("publication missing from archive");
    pub.lastPublishedHash = "hash-newer";
    pub.updatedAt = "2026-07-27T00:00:00.000Z";
    await repo.importLibrary(archive, LATER);
    const merged = await repo.publicationFor({ kind: "list", id: seeded.lisbon.id });
    expect(merged?.lastPublishedHash).toBe("hash-newer");
    expect(merged?.editorToken).toBe("list-token");
  });

  it("reassigns an incoming list's marker when a different live list already wears it", async () => {
    const local = await repo.createList("Local");
    const incoming: List = {
      id: "incoming-list",
      name: "Incoming",
      marker: local.marker,
      createdAt: LATER,
      updatedAt: LATER,
    };
    const archive: LibraryArchive = {
      v: 1,
      kind: "placemarks-library",
      exportedAt: LATER,
      places: [],
      lists: [incoming],
      listEntries: [],
      posts: [],
      publications: [],
    };
    await repo.importLibrary(archive, LATER);
    const lists = await repo.listLists();
    expect(lists).toHaveLength(2);
    const keptLocal = lists.find((l) => l.id === local.id);
    const reassigned = lists.find((l) => l.id === "incoming-list");
    expect(keptLocal && markerKey(keptLocal.marker)).toBe(markerKey(local.marker));
    expect(reassigned && markerKey(reassigned.marker)).not.toBe(markerKey(local.marker));
  });

  it("collapses duplicate (listId, placeId) entries to the (rank, id)-first row", async () => {
    const seeded = await seedLibrary();
    const existing = (await repo.entriesOf(seeded.lisbon.id)).find(
      (v) => v.place.id === seeded.cafe.id,
    )?.entry;
    if (!existing) throw new Error("entry missing");
    const duplicate: ListEntry = {
      id: "duplicate-entry",
      listId: seeded.lisbon.id,
      placeId: seeded.cafe.id,
      rank: rankBetween(null, existing.rank), // sorts before the existing entry
      createdAt: LATER,
      updatedAt: LATER,
    };
    const archive = await repo.exportLibrary({ includeCredentials: true });
    archive.listEntries.push(duplicate);
    await repo.importLibrary(archive, LATER);

    const entries = await repo.entriesOf(seeded.lisbon.id);
    const forCafe = entries.filter((v) => v.place.id === seeded.cafe.id);
    expect(forCafe).toHaveLength(1);
    expect(forCafe[0]?.entry.id).toBe("duplicate-entry");
  });

  it("re-establishes membership-is-existence: a merged place with no entry is dropped", async () => {
    const seeded = await seedLibrary();
    const archive = await repo.exportLibrary({ includeCredentials: true });
    const orphan: Place = {
      id: "orphan-place",
      name: "Orphan",
      lat: 1,
      lng: 1,
      origin: "search",
      createdAt: LATER,
      updatedAt: LATER,
    };
    archive.places.push(orphan);
    await repo.importLibrary(archive, LATER);
    expect(await repo.getPlace("orphan-place")).toBeUndefined();
    expect(await repo.getPlace(seeded.cafe.id)).toBeDefined();
  });
});

describe("archive shape", () => {
  it("names its format and version", async () => {
    const archive = await repo.exportLibrary({ includeCredentials: false });
    expect(archive.v).toBe(1);
    expect(archive.kind).toBe("placemarks-library");
    expect(Date.parse(archive.exportedAt)).not.toBeNaN();
  });
});

describe("posts type-level contract", () => {
  it("exposes no way to retarget a post", () => {
    // Compile-time pin: updatePost's patch accepts title/body only.
    type Patch = Parameters<DexieRepository["updatePost"]>[1];
    const patch: Patch = { title: "t", body: "b" };
    expect(patch).toBeTruthy();
    // @ts-expect-error — target is immutable after creation (spec/src/posts.md)
    const illegal: Patch = { target: { kind: "list", listId: "x" } };
    expect(illegal).toBeTruthy();
  });
});

describe("publication typing", () => {
  it("keeps Publication rows join-free at the boundary", async () => {
    const list = await repo.createList("Lisbon");
    const publication: Publication = await repo.createPublication(
      { kind: "list", id: list.id },
      "lisbon",
      "secret",
      NOW,
    );
    expect("targetKey" in publication).toBe(false);
  });
});

describe("posts row typing", () => {
  it("strips targetKey from every post read", async () => {
    const list = await repo.createList("Lisbon");
    const created: Post = await repo.createPost({ kind: "list", listId: list.id }, "Guide");
    expect("targetKey" in created).toBe(false);
    const read = await repo.getPost(created.id);
    expect(read && "targetKey" in read).toBe(false);
  });
});
