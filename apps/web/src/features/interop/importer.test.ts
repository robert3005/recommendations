/**
 * Import pipeline invariants at unit level (spec/src/interop.md §Testing):
 * each ladder rung, the geocoder-error pause, Note→place-post-once, the
 * "Saved places" auto list, source-key binding through renames, the
 * name+proximity prompt, and the idempotent re-import convergence contract —
 * driven through an in-memory LocalRepository that implements the pinned
 * dedup precedence (feature id → osmRef → name+proximity).
 */
import type {
  GeocoderCandidate,
  ImportBatch,
  ImportItem,
  List,
  Place,
  Post,
  PostTarget,
} from "@placemarks/domain";
import {
  assignMarker,
  distanceMeters,
  googleFeatureId,
  normalizeName,
  osmRefKey,
  postTargetKey,
} from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import type { AddOptions, AddResult, AddSource, LocalRepository } from "../../data/repo";
import type { Geocoder } from "../../providers";
import {
  abandonImport,
  listReviewItems,
  resolveReviewItem,
  resumeImport,
  runImport,
} from "./importer";
import { SAVED_PLACES_LIST_NAME } from "./parse";

const NOW = "2026-07-26T12:00:00.000Z";
const PLACE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";
const PIN_URL = "https://www.google.com/maps/search/38.71,-9.15";
const GEO_ONLY_URL = "https://maps.google.com/?cid=777";

/** In-memory LocalRepository subset the importer touches — dedup ladder included. */
class MemoryRepo {
  places = new Map<string, Place>();
  lists: List[] = [];
  entries: { id: string; listId: string; placeId: string }[] = [];
  posts: Post[] = [];
  batches = new Map<string, ImportBatch>();
  items = new Map<string, ImportItem>();
  private seq = 0;
  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString()}`;
  }

  getPlace(id: string): Promise<Place | undefined> {
    return Promise.resolve(this.places.get(id));
  }
  findByGoogleFeatureId(fid: string): Promise<Place | undefined> {
    return Promise.resolve(
      [...this.places.values()].find((p) => p.googleUrl && googleFeatureId(p.googleUrl) === fid),
    );
  }
  findByOsmRef(ref: NonNullable<Place["osmRef"]>): Promise<Place | undefined> {
    return Promise.resolve(
      [...this.places.values()].find((p) => p.osmRef && osmRefKey(p.osmRef) === osmRefKey(ref)),
    );
  }
  listLists(): Promise<List[]> {
    return Promise.resolve([...this.lists]);
  }
  createList(name: string, opts?: { preferColor?: string; sourceKey?: string }): Promise<List> {
    const { marker } = assignMarker(
      this.lists.map((l) => l.marker),
      opts?.preferColor,
    );
    const list: List = {
      id: this.id("list"),
      name,
      marker,
      ...(opts?.sourceKey ? { sourceKey: opts.sourceKey } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.lists.push(list);
    return Promise.resolve(list);
  }
  entriesOf(listId: string): Promise<{ entry: { id: string }; place: Place }[]> {
    return Promise.resolve(
      this.entries
        .filter((e) => e.listId === listId)
        .flatMap((e) => {
          const place = this.places.get(e.placeId);
          return place ? [{ entry: { id: e.id }, place }] : [];
        }),
    );
  }
  findListBySourceKey(key: string): Promise<List | undefined> {
    return Promise.resolve(this.lists.find((l) => l.sourceKey === key));
  }
  setListSourceKey(id: string, sourceKey: string): Promise<void> {
    const list = this.lists.find((l) => l.id === id);
    if (list && list.sourceKey === undefined) list.sourceKey = sourceKey;
    return Promise.resolve();
  }
  findListByName(name: string): Promise<List | undefined> {
    return Promise.resolve(this.lists.find((l) => l.name === name));
  }
  async addToList(listId: string, source: AddSource, _opts?: AddOptions): Promise<AddResult> {
    if (source.kind === "existing") {
      const place = this.places.get(source.placeId);
      if (!place) throw new Error("missing place");
      if (this.entries.some((e) => e.listId === listId && e.placeId === place.id)) {
        return { status: "already-member", place };
      }
      this.entries.push({ id: this.id("e"), listId, placeId: place.id });
      return { status: "added", place };
    }
    const facts = source.facts;
    // The pinned dedup precedence: feature id → osmRef → name+proximity.
    const fid = facts.googleUrl ? googleFeatureId(facts.googleUrl) : undefined;
    let existing = fid ? await this.findByGoogleFeatureId(fid) : undefined;
    if (!existing && facts.osmRef) existing = await this.findByOsmRef(facts.osmRef);
    if (existing) return this.addToList(listId, { kind: "existing", placeId: existing.id });
    if (!_opts?.forceNew) {
      const near = [...this.places.values()].find(
        (p) =>
          normalizeName(p.name) === normalizeName(facts.name) &&
          distanceMeters(p.lat, p.lng, facts.lat, facts.lng) < 150,
      );
      if (near) return { status: "name-proximity-conflict", existing: near };
    }
    const place: Place = {
      id: this.id("p"),
      name: facts.name,
      lat: facts.lat,
      lng: facts.lng,
      ...(facts.address ? { address: facts.address } : {}),
      ...(facts.category ? { category: facts.category } : {}),
      origin: facts.origin,
      ...(facts.googleUrl ? { googleUrl: facts.googleUrl } : {}),
      ...(facts.appleUrl ? { appleUrl: facts.appleUrl } : {}),
      ...(facts.osmRef ? { osmRef: facts.osmRef } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.places.set(place.id, place);
    this.entries.push({ id: this.id("e"), listId, placeId: place.id });
    return { status: "added", place };
  }
  postsFor(target: PostTarget): Promise<Post[]> {
    return Promise.resolve(
      this.posts.filter((p) => postTargetKey(p.target) === postTargetKey(target)),
    );
  }
  createPost(target: PostTarget, title: string): Promise<Post> {
    const post: Post = {
      id: this.id("post"),
      target,
      title,
      body: "",
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.posts.push(post);
    return Promise.resolve(post);
  }
  updatePost(id: string, patch: { title?: string; body?: string }): Promise<void> {
    const post = this.posts.find((p) => p.id === id);
    if (post) Object.assign(post, patch, { updatedAt: NOW });
    return Promise.resolve();
  }
  createImportBatch(b: ImportBatch): Promise<void> {
    this.batches.set(b.id, { ...b });
    return Promise.resolve();
  }
  getImportBatch(id: string): Promise<ImportBatch | undefined> {
    return Promise.resolve(this.batches.get(id));
  }
  listImportBatches(): Promise<ImportBatch[]> {
    return Promise.resolve([...this.batches.values()]);
  }
  setBatchStatus(id: string, status: ImportBatch["status"]): Promise<void> {
    const batch = this.batches.get(id);
    if (batch) batch.status = status;
    return Promise.resolve();
  }
  putImportItems(items: ImportItem[]): Promise<void> {
    for (const item of items) this.items.set(item.id, { ...item });
    return Promise.resolve();
  }
  itemsOf(batchId: string): Promise<ImportItem[]> {
    return Promise.resolve([...this.items.values()].filter((i) => i.batchId === batchId));
  }
  updateImportItem(item: ImportItem): Promise<void> {
    this.items.set(item.id, { ...item });
    return Promise.resolve();
  }

  asRepo(): LocalRepository {
    return this as unknown as LocalRepository;
  }
}

function geocoderStub(
  byQuery: Record<string, GeocoderCandidate[]>,
): Geocoder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    search: (text: string) => {
      calls.push(text);
      return Promise.resolve(byQuery[text] ?? []);
    },
    lookup: () => Promise.resolve(undefined),
  };
}

function failingGeocoder(): Geocoder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    search: (text: string) => {
      calls.push(text);
      return Promise.reject(new Error("geocoder down"));
    },
    lookup: () => Promise.resolve(undefined),
  };
}

const MYSTERY: GeocoderCandidate = {
  name: "Mystery Bar",
  lat: 38.72,
  lng: -9.14,
  address: "Nowhere 1",
  osmRef: { type: "node", id: "77" },
};

function takeoutZip(): { name: string; bytes: Uint8Array } {
  const csv = [
    "Title,Note,URL,Address",
    `"Café Central","Great bica","${PLACE_URL}","Rua Example 12, Lisboa"`,
    `"Dropped pin",,"${PIN_URL}",`,
    `"Mystery Bar",,,"Nowhere 1"`,
  ].join("\n");
  const savedPlaces = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
        properties: { Title: "Café Central", "Google Maps URL": PLACE_URL },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-9.2, 38.8] },
        properties: { Title: "Geo Only", "Google Maps URL": GEO_ONLY_URL },
      },
    ],
  };
  return {
    name: "takeout.zip",
    bytes: zipSync({
      "Takeout/Saved/Lisbon trip.csv": strToU8(csv),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(JSON.stringify(savedPlaces)),
    }),
  };
}

describe("the coordinate ladder", () => {
  let repo: MemoryRepo;
  beforeEach(() => {
    repo = new MemoryRepo();
  });

  it("joins by feature id, reads literal pins, auto-places one matching candidate, and reports every row", async () => {
    const geocoder = geocoderStub({ "Mystery Bar, Nowhere 1": [MYSTERY] });
    const report = await runImport(repo.asRepo(), takeoutZip(), { geocoder }, NOW);

    expect(report.rows).toBe(4); // 3 CSV rows + 1 Saved Places leftover entry
    expect(report.placed).toBe(4);
    expect(report.review).toBe(0);
    expect(report.skipped).toBe(0);

    const central = [...repo.places.values()].find((p) => p.name === "Café Central");
    expect(central?.lat).toBe(38.7139); // rung 2: joined from the archive's GeoJSON
    expect(central?.googleUrl).toBe(PLACE_URL);
    expect(central?.osmRef).toBeUndefined(); // Google-derived facts record no osmRef

    const pin = [...repo.places.values()].find((p) => p.name === "Dropped pin");
    expect(pin?.lat).toBe(38.71); // rung 1: literal coordinates in the URL

    // Rung 3: geocoder results are OSM data — auto-placement records the osmRef.
    const mystery = [...repo.places.values()].find((p) => p.name === "Mystery Bar");
    expect(mystery?.osmRef).toEqual({ type: "node", id: "77" });

    // The GeoJSON-only entry lives in the auto "Saved places" list, bound to the file.
    const saved = repo.lists.find((l) => l.name === SAVED_PLACES_LIST_NAME);
    expect(saved?.sourceKey).toBe("Saved Places.json");
    const geoOnly = [...repo.places.values()].find((p) => p.name === "Geo Only");
    expect(geoOnly).toBeDefined();
    expect(repo.entries.some((e) => e.listId === saved?.id && e.placeId === geoOnly?.id)).toBe(
      true,
    );

    // The Note became a place post titled with the place's name.
    const posts = repo.posts.filter(
      (p) => postTargetKey(p.target) === `place:${central?.id ?? ""}`,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ title: "Café Central", body: "Great bica" });

    const batch = [...repo.batches.values()][0];
    expect(batch?.status).toBe("done");
  });

  it("one of several same-named results auto-places when only its address corroborates the row", async () => {
    const elsewhere: GeocoderCandidate = {
      name: "Mystery Bar",
      lat: 40,
      lng: -8,
      address: "Far 7",
    };
    const geocoder = geocoderStub({ "Mystery Bar, Nowhere 1": [elsewhere, MYSTERY] });
    const report = await runImport(repo.asRepo(), takeoutZip(), { geocoder }, NOW);
    expect(report.review).toBe(0);
    const mystery = [...repo.places.values()].find((p) => p.name === "Mystery Bar");
    expect(mystery?.osmRef).toEqual({ type: "node", id: "77" });
  });

  // Two results the row's address corroborates equally: a tie is a review.
  it("multiple candidates go to review with their osmRefs recorded", async () => {
    const other: GeocoderCandidate = {
      name: "Mystery Bar",
      lat: 40,
      lng: -8,
      address: "Nowhere 1",
    };
    const geocoder = geocoderStub({ "Mystery Bar, Nowhere 1": [MYSTERY, other] });
    const report = await runImport(repo.asRepo(), takeoutZip(), { geocoder }, NOW);
    expect(report.review).toBe(1);
    expect(report.geocodePending).toBe(0);

    const queue = await listReviewItems(repo.asRepo());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.item.raw.title).toBe("Mystery Bar");
    expect(queue[0]?.item.candidates?.[0]?.osmRef).toEqual({ type: "node", id: "77" });
    expect([...repo.batches.values()][0]?.status).toBe("reviewing");
  });

  it("an empty geocoder result is a genuine miss — review with no candidates", async () => {
    const geocoder = geocoderStub({});
    const report = await runImport(repo.asRepo(), takeoutZip(), { geocoder }, NOW);
    expect(report.review).toBe(1);
    expect(report.geocodePending).toBe(0);
    const queue = await listReviewItems(repo.asRepo());
    expect(queue[0]?.item.candidates).toEqual([]);
  });
});

describe("geocoder errors pause the rung", () => {
  it("an error leaves rows pending, stops further geocoding, and resume retries them", async () => {
    const repo = new MemoryRepo();
    const csv = [
      "Title,Note,URL,Address",
      `"Mystery Bar",,,"Nowhere 1"`,
      `"Second Bar",,,"Nowhere 2"`,
    ].join("\n");
    const file = { name: "bars.csv", bytes: strToU8(csv) };

    const down = failingGeocoder();
    const report = await runImport(repo.asRepo(), file, { geocoder: down }, NOW);
    expect(report.review).toBe(2);
    expect(report.geocodePending).toBe(2);
    expect(down.calls).toHaveLength(1); // the rung paused after the first error
    expect([...repo.batches.values()][0]?.status).toBe("reviewing");

    const up = geocoderStub({
      "Mystery Bar, Nowhere 1": [MYSTERY],
      "Second Bar, Nowhere 2": [
        {
          name: "Second Bar",
          lat: 38.75,
          lng: -9.1,
          address: "Nowhere 2",
          osmRef: { type: "way", id: "9" },
        },
      ],
    });
    const resumed = await resumeImport(repo.asRepo(), { geocoder: up }, NOW);
    expect(resumed.placed).toBe(2);
    expect(resumed.geocodePending).toBe(0);
    expect([...repo.batches.values()][0]?.status).toBe("done");
    expect(repo.places.size).toBe(2);
  });

  it("identical pending rows adopt into the newest batch instead of piling up", async () => {
    const repo = new MemoryRepo();
    const file = {
      name: "bars.csv",
      bytes: strToU8(`Title,Note,URL,Address\n"Mystery Bar",,,"Nowhere 1"\n`),
    };
    await runImport(repo.asRepo(), file, { geocoder: failingGeocoder() }, NOW);
    await runImport(repo.asRepo(), file, { geocoder: failingGeocoder() }, NOW);

    const queue = await listReviewItems(repo.asRepo());
    expect(queue).toHaveLength(1);
    const batches = [...repo.batches.values()];
    expect(batches).toHaveLength(2);
    expect(batches[0]?.status).toBe("done"); // emptied by adoption
    expect(batches[1]?.status).toBe("reviewing");
  });
});

describe("review resolution", () => {
  let repo: MemoryRepo;
  beforeEach(() => {
    repo = new MemoryRepo();
  });

  const reviewFile = {
    name: "bars.csv",
    bytes: strToU8(`Title,Note,URL,Address\n"Mystery Bar","hidden door",,"Nowhere 1"\n`),
  };

  it("picking a candidate places the row with the result's facts and its osmRef", async () => {
    const geocoder = geocoderStub({
      "Mystery Bar, Nowhere 1": [
        MYSTERY,
        { name: "Mystery Bar", lat: 40, lng: -8, address: "Nowhere 1" },
      ],
    });
    await runImport(repo.asRepo(), reviewFile, { geocoder }, NOW);
    const [entry] = await listReviewItems(repo.asRepo());
    expect(entry).toBeDefined();
    const outcome = await resolveReviewItem(
      repo.asRepo(),
      entry?.item.id ?? "",
      { kind: "candidate", index: 0 },
      NOW,
    );
    expect(outcome.status).toBe("resolved");
    const place = [...repo.places.values()].find((p) => p.name === "Mystery Bar");
    expect(place?.osmRef).toEqual({ type: "node", id: "77" });
    expect(place?.lat).toBe(38.72);
    // The note rode along at resolution time.
    expect(repo.posts[0]).toMatchObject({ title: "Mystery Bar", body: "hidden door" });
    expect([...repo.batches.values()][0]?.status).toBe("done");
  });

  it("manual placement yields user coordinates and no osmRef; out-of-range is refused", async () => {
    await runImport(repo.asRepo(), reviewFile, { geocoder: geocoderStub({}) }, NOW);
    const [entry] = await listReviewItems(repo.asRepo());
    const bad = await resolveReviewItem(
      repo.asRepo(),
      entry?.item.id ?? "",
      { kind: "coords", lat: 91, lng: 0 },
      NOW,
    );
    expect(bad.status).toBe("pending");
    const outcome = await resolveReviewItem(
      repo.asRepo(),
      entry?.item.id ?? "",
      { kind: "coords", lat: 38.7, lng: -9.1 },
      NOW,
    );
    expect(outcome.status).toBe("resolved");
    const place = [...repo.places.values()].find((p) => p.name === "Mystery Bar");
    expect(place?.osmRef).toBeUndefined();
    expect(place?.lat).toBe(38.7);
  });

  it("skips are recorded and close the batch; abandon skips the rest", async () => {
    await runImport(repo.asRepo(), reviewFile, { geocoder: geocoderStub({}) }, NOW);
    const [entry] = await listReviewItems(repo.asRepo());
    const outcome = await resolveReviewItem(
      repo.asRepo(),
      entry?.item.id ?? "",
      { kind: "skip" },
      NOW,
    );
    expect(outcome.status).toBe("resolved");
    expect([...repo.items.values()][0]?.status).toBe("skipped");
    expect([...repo.batches.values()][0]?.status).toBe("done");

    // Abandon: remaining review rows become explicit skips.
    const repo2 = new MemoryRepo();
    await runImport(repo2.asRepo(), reviewFile, { geocoder: geocoderStub({}) }, NOW);
    const batchId = [...repo2.batches.keys()][0] ?? "";
    await abandonImport(repo2.asRepo(), batchId);
    expect(repo2.batches.get(batchId)?.status).toBe("abandoned");
    expect([...repo2.items.values()].every((i) => i.status !== "review")).toBe(true);
  });

  it("a name+proximity match prompts: use-existing converges, force-new keeps both", async () => {
    // A local place with the same name nearby, carrying no dedup refs.
    const mine = await repo.createList("Mine", {});
    await repo.addToList(mine.id, {
      kind: "new",
      facts: { name: "Mystery Bar", lat: 38.7001, lng: -9.1001, origin: "search" },
    });
    await runImport(repo.asRepo(), reviewFile, { geocoder: geocoderStub({}) }, NOW);
    const [entry] = await listReviewItems(repo.asRepo());

    const conflicted = await resolveReviewItem(
      repo.asRepo(),
      entry?.item.id ?? "",
      { kind: "coords", lat: 38.7, lng: -9.1 },
      NOW,
    );
    expect(conflicted.status).toBe("conflict");
    const existingId = conflicted.status === "conflict" ? conflicted.existing.id : "";

    const merged = await resolveReviewItem(
      repo.asRepo(),
      entry?.item.id ?? "",
      {
        kind: "coords",
        lat: 38.7,
        lng: -9.1,
        conflict: { kind: "use-existing", placeId: existingId },
      },
      NOW,
    );
    expect(merged.status).toBe("resolved");
    expect(repo.places.size).toBe(1); // converged, no new place

    // force-new keeps both (fresh repo, same setup).
    const repo2 = new MemoryRepo();
    const mine2 = await repo2.createList("Mine", {});
    await repo2.addToList(mine2.id, {
      kind: "new",
      facts: { name: "Mystery Bar", lat: 38.7001, lng: -9.1001, origin: "search" },
    });
    await runImport(repo2.asRepo(), reviewFile, { geocoder: geocoderStub({}) }, NOW);
    const [entry2] = await listReviewItems(repo2.asRepo());
    const kept = await resolveReviewItem(
      repo2.asRepo(),
      entry2?.item.id ?? "",
      { kind: "coords", lat: 38.7, lng: -9.1, conflict: { kind: "force-new" } },
      NOW,
    );
    expect(kept.status).toBe("resolved");
    expect(repo2.places.size).toBe(2);
  });
});

describe("idempotent re-import", () => {
  it("import → resolve review → re-import converges: nothing new, notes dropped, binding survives renames", async () => {
    const repo = new MemoryRepo();
    const geocoder = geocoderStub({
      "Mystery Bar, Nowhere 1": [
        MYSTERY,
        { name: "Mystery Bar", lat: 40, lng: -8, address: "Nowhere 1" },
      ],
    });

    const first = await runImport(repo.asRepo(), takeoutZip(), { geocoder }, NOW);
    expect(first.placed).toBe(3);
    expect(first.review).toBe(1);

    const [entry] = await listReviewItems(repo.asRepo());
    await resolveReviewItem(
      repo.asRepo(),
      entry?.item.id ?? "",
      { kind: "candidate", index: 0 },
      NOW,
    );

    // The user renames the bound list and edits the imported note's post.
    const trip = repo.lists.find((l) => l.sourceKey === "Lisbon trip.csv");
    expect(trip).toBeDefined();
    if (trip) trip.name = "Renamed trip";
    const post = repo.posts[0];
    expect(post).toBeDefined();
    await repo.updatePost(post?.id ?? "", { body: "edited locally" });

    const placesBefore = repo.places.size;
    const entriesBefore = repo.entries.length;
    const listsBefore = repo.lists.length;

    const second = await runImport(repo.asRepo(), takeoutZip(), { geocoder }, NOW);
    expect(second.placed).toBe(0);
    expect(second.alreadyPresent).toBe(4); // every row converged on its membership
    expect(second.review).toBe(0);
    expect(second.droppedNotes).toBe(1); // the place already has a post — dropped and reported

    expect(repo.places.size).toBe(placesBefore);
    expect(repo.entries.length).toBe(entriesBefore);
    expect(repo.lists.length).toBe(listsBefore); // the rename held: sourceKey bound the re-import
    expect(repo.posts).toHaveLength(1);
    expect(repo.posts[0]?.body).toBe("edited locally"); // local edits are canon
    expect([...repo.batches.values()].every((b) => b.status === "done")).toBe(true);
  });
});
