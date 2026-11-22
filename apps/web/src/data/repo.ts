/**
 * LocalRepository over Dexie — domain writes go through repository
 * transactions, which enforce the model's invariants in the same transaction
 * that performs the write (spec/src/storage.md §Repository invariants):
 *
 *  - the library owns places: a place exists on its own, on any number of
 *    lists including none; leaving a list never deletes it, and only an
 *    explicit deletePlace removes it (with all its entries);
 *  - one live (listId, placeId) pair;
 *  - marker uniqueness across live lists up to the 64-pair space, badged
 *    deterministic repeats beyond;
 *  - the teardown refusals (spec/src/data-model.md §Teardown);
 *  - post-target existence at creation; a post's target never changes.
 *
 * Dedup precedence everywhere (add, import, re-import): Google feature id →
 * osmRef → name + proximity, which prompts the user rather than merging
 * silently — surfaced as the name-proximity-conflict AddResult.
 */
import type {
  ImportBatch,
  ImportItem,
  List,
  ListEntry,
  ListMarker,
  OsmRef,
  Place,
  PlaceFilter,
  PlaceId,
  PlaceRating,
  PlaceStatus,
  Post,
  PostTarget,
  Publication,
  SavedView,
} from "@placemarks/domain";
import {
  assignMarker,
  compactFilter,
  compareByRank,
  googleFeatureId,
  markerKey,
  normalizeName,
  normalizeTags,
  osmRefKey,
  postTargetKey,
  publicationTargetKey,
  rankAfter,
  rankBetween,
} from "@placemarks/domain";
import { newId } from "../lib/id";
import { nowIso } from "../lib/time";
import { type ListEntryRow, PlacemarksDb, type PublicationRow } from "./db";
import {
  assertValidCoords,
  duplicateEntryIds,
  incomingWins,
  nameProximityCandidate,
  stripPlaceRow,
  stripPostRow,
  stripPublicationRow,
  toPlaceRow,
  toPostRow,
  toPublicationRow,
} from "./decisions";

export interface PlaceView {
  place: Place;
  listIds: string[];
}

export type BlockerKind = "place-has-posts" | "list-has-posts" | "live-publication";

export interface Blocker {
  kind: BlockerKind;
  ids: string[];
}

/** A refused teardown names what still hangs off the target (spec/src/data-model.md §Teardown). */
export class TeardownRefusedError extends Error {
  blockers: Blocker[];

  constructor(message: string, blockers: Blocker[]) {
    super(message);
    this.name = "TeardownRefusedError";
    this.blockers = blockers;
  }
}

export type NewPlaceFacts = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  origin: Place["origin"];
  googleUrl?: string;
  appleUrl?: string;
  osmRef?: OsmRef;
  imageUrl?: string; // Wikimedia-hosted only, derived at OSM lookup time
};

export type AddSource =
  | { kind: "new"; facts: NewPlaceFacts }
  | { kind: "existing"; placeId: string };

export type AddResult =
  | { status: "added" | "already-member"; place: Place }
  /** Caller prompts, then retries with {kind:"existing"} or forceNew. */
  | { status: "name-proximity-conflict"; existing: Place };

/** Saving to the library without a list: created, or the existing place it deduplicated to. */
export type SaveResult =
  | { status: "saved" | "already-saved"; place: Place }
  | { status: "name-proximity-conflict"; existing: Place };

/**
 * The owner's own layer on a place. `null` clears a field; an absent key
 * leaves it alone. Tags are normalised on the way in.
 */
export interface PlacePersonalPatch {
  tags?: string[];
  note?: string | null;
  rating?: PlaceRating | null;
  status?: PlaceStatus | null;
}

export interface AddOptions {
  forceNew?: boolean;
  now?: string;
}

/**
 * The id-preserving backup and migration format (spec/src/interop.md §The
 * library archive): the whole library in one JSON document, entity ids intact
 * so place:/post: links and post targets survive restore. editorToken is
 * stripped unless the export explicitly includes credentials.
 */
export interface LibraryArchive {
  v: 1;
  kind: "placemarks-library";
  exportedAt: string;
  places: Place[];
  lists: List[];
  listEntries: ListEntry[];
  posts: Post[];
  publications: Publication[];
  /** Saved views; absent in archives written before views existed. */
  views?: SavedView[];
}

/** The place facts an edit (or enrichment) may patch — identity and provenance excluded. */
export type PlaceFactsPatch = Partial<
  Pick<
    Place,
    | "name"
    | "address"
    | "category"
    | "lat"
    | "lng"
    | "imageUrl"
    | "website"
    | "phone"
    | "openingHours"
    | "cuisine"
    | "wheelchair"
    | "description"
    | "descriptionSource"
    | "wikipediaUrl"
  >
>;

export interface LocalRepository {
  // places
  getPlace(id: PlaceId): Promise<Place | undefined>;
  updatePlaceFacts(id: PlaceId, patch: PlaceFactsPatch): Promise<void>;
  /** Save a place to the library on no list — dedups exactly like addToList. */
  savePlace(facts: NewPlaceFacts, opts?: AddOptions): Promise<SaveResult>;
  updatePlacePersonal(id: PlaceId, patch: PlacePersonalPatch): Promise<void>;
  /** Removes the place and every list entry; refused while posts target it. */
  deletePlace(id: PlaceId): Promise<void>;
  listPlaceViews(): Promise<PlaceView[]>;
  findByGoogleFeatureId(fid: string): Promise<Place | undefined>;
  findByOsmRef(ref: OsmRef): Promise<Place | undefined>;
  // lists
  listLists(): Promise<List[]>;
  getList(id: string): Promise<List | undefined>;
  createList(name: string, opts?: { preferColor?: string; sourceKey?: string }): Promise<List>;
  renameList(id: string, name: string): Promise<void>;
  setListMarker(id: string, marker: ListMarker): Promise<void>;
  /** An empty or whitespace description clears it. */
  setListDescription(id: string, description: string): Promise<void>;
  /** Deletes the list and its entries; its places stay in the library. */
  deleteList(id: string): Promise<void>;
  findListBySourceKey(key: string): Promise<List | undefined>;
  /** Records the source binding on first import; never overwrites an existing one. */
  setListSourceKey(id: string, sourceKey: string): Promise<void>;
  findListByName(name: string): Promise<List | undefined>;
  // entries
  entriesOf(listId: string): Promise<{ entry: ListEntry; place: Place }[]>;
  addToList(listId: string, source: AddSource, opts?: AddOptions): Promise<AddResult>;
  moveEntry(entryId: string, beforeEntryId: string | null): Promise<void>;
  /** Takes the place off the list; the place itself stays in the library. */
  removeEntry(entryId: string): Promise<void>;
  /** The same, addressed by the pair — what the place card knows. */
  removeFromList(listId: string, placeId: PlaceId): Promise<void>;
  // saved views
  listViews(): Promise<SavedView[]>;
  createView(name: string, filter: PlaceFilter): Promise<SavedView>;
  updateView(id: string, patch: { name?: string; filter?: PlaceFilter }): Promise<void>;
  deleteView(id: string): Promise<void>;
  // posts
  getPost(id: string): Promise<Post | undefined>;
  postsFor(target: PostTarget): Promise<Post[]>;
  allPosts(): Promise<Post[]>;
  createPost(target: PostTarget, title: string): Promise<Post>;
  updatePost(id: string, patch: { title?: string; body?: string }): Promise<void>;
  deletePost(id: string): Promise<void>;
  // publications
  publicationFor(target: Publication["target"]): Promise<Publication | undefined>;
  createPublication(
    target: Publication["target"],
    slug: string,
    editorToken: string,
    now: string,
  ): Promise<Publication>;
  recordPublished(id: string, lastPublishedHash: string, now: string): Promise<void>;
  markRevoked(id: string, now: string): Promise<void>;
  livePublications(): Promise<Publication[]>;
  // imports
  createImportBatch(b: ImportBatch): Promise<void>;
  getImportBatch(id: string): Promise<ImportBatch | undefined>;
  listImportBatches(): Promise<ImportBatch[]>;
  setBatchStatus(id: string, status: ImportBatch["status"]): Promise<void>;
  putImportItems(items: ImportItem[]): Promise<void>;
  itemsOf(batchId: string): Promise<ImportItem[]>;
  updateImportItem(item: ImportItem): Promise<void>;
  // settings
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;
  // archive
  exportLibrary(opts: { includeCredentials: boolean }): Promise<LibraryArchive>;
  importLibrary(a: LibraryArchive, now?: string): Promise<{ mode: "fresh" | "merge" }>;
}

const byCreation = <T extends { createdAt: string; id: string }>(a: T, b: T): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : 1);

export class DexieRepository implements LocalRepository {
  readonly db: PlacemarksDb;

  constructor(dbName?: string) {
    this.db = new PlacemarksDb(dbName);
  }

  // ---------- places ----------

  async getPlace(id: PlaceId): Promise<Place | undefined> {
    const row = await this.db.places.get(id);
    return row ? stripPlaceRow(row) : undefined;
  }

  async updatePlaceFacts(id: PlaceId, patch: PlaceFactsPatch): Promise<void> {
    await this.db.transaction("rw", [this.db.places], async () => {
      const row = await this.db.places.get(id);
      if (!row) throw new Error("place not found");
      const place = stripPlaceRow(row);
      // Facts are the user's copy; identity and provenance never change here.
      // Only defined patch keys land — an absent key never clears a fact.
      const next: Place = {
        ...place,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.lat !== undefined ? { lat: patch.lat } : {}),
        ...(patch.lng !== undefined ? { lng: patch.lng } : {}),
        ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
        ...(patch.website !== undefined ? { website: patch.website } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.openingHours !== undefined ? { openingHours: patch.openingHours } : {}),
        ...(patch.cuisine !== undefined ? { cuisine: patch.cuisine } : {}),
        ...(patch.wheelchair !== undefined ? { wheelchair: patch.wheelchair } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.descriptionSource !== undefined
          ? { descriptionSource: patch.descriptionSource }
          : {}),
        ...(patch.wikipediaUrl !== undefined ? { wikipediaUrl: patch.wikipediaUrl } : {}),
        updatedAt: nowIso(),
      };
      assertValidCoords(next.lat, next.lng);
      await this.db.places.put(toPlaceRow(next));
    });
  }

  async savePlace(facts: NewPlaceFacts, opts?: AddOptions): Promise<SaveResult> {
    const now = opts?.now ?? nowIso();
    return this.db.transaction("rw", [this.db.places], async (): Promise<SaveResult> => {
      const resolved = await this.resolvePlace(facts, now, opts?.forceNew === true);
      if (resolved.status === "conflict") {
        return { status: "name-proximity-conflict", existing: resolved.existing };
      }
      return { status: resolved.created ? "saved" : "already-saved", place: resolved.place };
    });
  }

  async updatePlacePersonal(id: PlaceId, patch: PlacePersonalPatch): Promise<void> {
    await this.db.transaction("rw", [this.db.places], async () => {
      const row = await this.db.places.get(id);
      if (!row) throw new Error("place not found");
      const { tags: _t, note: _n, rating: _r, status: _s, ...rest } = stripPlaceRow(row);
      const current = stripPlaceRow(row);
      const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : (current.tags ?? []);
      const note =
        patch.note === undefined ? current.note : patch.note === null ? undefined : patch.note;
      const rating =
        patch.rating === undefined
          ? current.rating
          : patch.rating === null
            ? undefined
            : patch.rating;
      const status =
        patch.status === undefined
          ? current.status
          : patch.status === null
            ? undefined
            : patch.status;
      const next: Place = {
        ...rest,
        ...(tags.length > 0 ? { tags } : {}),
        ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(status !== undefined ? { status } : {}),
        updatedAt: nowIso(),
      };
      await this.db.places.put(toPlaceRow(next));
    });
  }

  async deletePlace(id: PlaceId): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.places, this.db.listEntries, this.db.posts],
      async () => {
        if (!(await this.db.places.get(id))) return;
        // Nothing the owner wrote is deleted as a side effect.
        const posts = await this.db.posts
          .where("targetKey")
          .equals(postTargetKey({ kind: "place", placeId: id }))
          .toArray();
        if (posts.length > 0) {
          throw new TeardownRefusedError(
            "deleting this place is refused while posts target it — delete the place posts first",
            [{ kind: "place-has-posts", ids: posts.map((p) => p.id).sort() }],
          );
        }
        await this.db.listEntries.where("placeId").equals(id).delete();
        await this.db.places.delete(id);
      },
    );
  }

  /**
   * Find the library place these facts describe, or create it. Dedup
   * precedence: Google feature id → osmRef → name + proximity, which never
   * merges silently. Must run inside a transaction over `places`.
   */
  private async resolvePlace(
    facts: NewPlaceFacts,
    now: string,
    forceNew: boolean,
  ): Promise<
    { status: "ok"; place: Place; created: boolean } | { status: "conflict"; existing: Place }
  > {
    assertValidCoords(facts.lat, facts.lng);
    const featureId = facts.googleUrl ? googleFeatureId(facts.googleUrl) : undefined;
    let found = featureId ? await this.findByGoogleFeatureId(featureId) : undefined;
    found ??= facts.osmRef ? await this.findByOsmRef(facts.osmRef) : undefined;
    if (!found && !forceNew) {
      const nearby = nameProximityCandidate(
        facts,
        (await this.db.places.toArray()).map(stripPlaceRow),
      );
      // Never merged silently — the caller prompts and retries.
      if (nearby) return { status: "conflict", existing: nearby };
    }

    if (found) {
      // The user's copy of the facts is canon; a dedup hit only fills in
      // provenance refs the place was missing (deep links + dedup keys),
      // and a missing photo the same way.
      const filled: Place = {
        ...found,
        ...(facts.googleUrl !== undefined && found.googleUrl === undefined
          ? { googleUrl: facts.googleUrl }
          : {}),
        ...(facts.appleUrl !== undefined && found.appleUrl === undefined
          ? { appleUrl: facts.appleUrl }
          : {}),
        ...(facts.osmRef !== undefined && found.osmRef === undefined
          ? { osmRef: facts.osmRef }
          : {}),
        ...(facts.imageUrl !== undefined && found.imageUrl === undefined
          ? { imageUrl: facts.imageUrl }
          : {}),
      };
      if (
        filled.googleUrl !== found.googleUrl ||
        filled.appleUrl !== found.appleUrl ||
        filled.osmRef !== found.osmRef ||
        filled.imageUrl !== found.imageUrl
      ) {
        const place = { ...filled, updatedAt: now };
        await this.db.places.put(toPlaceRow(place));
        return { status: "ok", place, created: false };
      }
      return { status: "ok", place: found, created: false };
    }

    const place: Place = {
      id: newId(),
      name: facts.name,
      lat: facts.lat,
      lng: facts.lng,
      ...(facts.address !== undefined ? { address: facts.address } : {}),
      ...(facts.category !== undefined ? { category: facts.category } : {}),
      origin: facts.origin,
      ...(facts.googleUrl !== undefined ? { googleUrl: facts.googleUrl } : {}),
      ...(facts.appleUrl !== undefined ? { appleUrl: facts.appleUrl } : {}),
      ...(facts.osmRef !== undefined ? { osmRef: facts.osmRef } : {}),
      ...(facts.imageUrl !== undefined ? { imageUrl: facts.imageUrl } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.places.put(toPlaceRow(place));
    return { status: "ok", place, created: true };
  }

  async listPlaceViews(): Promise<PlaceView[]> {
    return this.db.transaction("r", [this.db.places, this.db.listEntries], async () => {
      const [rows, entries] = await Promise.all([
        this.db.places.toArray(),
        this.db.listEntries.toArray(),
      ]);
      const listIdsByPlace = new Map<string, string[]>();
      for (const entry of [...entries].sort(byCreation)) {
        const ids = listIdsByPlace.get(entry.placeId) ?? [];
        if (!ids.includes(entry.listId)) ids.push(entry.listId);
        listIdsByPlace.set(entry.placeId, ids);
      }
      return rows
        .map(
          (row): PlaceView => ({
            place: stripPlaceRow(row),
            listIds: listIdsByPlace.get(row.id) ?? [],
          }),
        )
        .sort((a, b) =>
          a.place.name < b.place.name
            ? -1
            : a.place.name > b.place.name
              ? 1
              : byId(a.place, b.place),
        );
    });
  }

  async findByGoogleFeatureId(fid: string): Promise<Place | undefined> {
    const row = await this.db.places.where("googleFeatureId").equals(fid).first();
    return row ? stripPlaceRow(row) : undefined;
  }

  async findByOsmRef(ref: OsmRef): Promise<Place | undefined> {
    const row = await this.db.places.where("osmKey").equals(osmRefKey(ref)).first();
    return row ? stripPlaceRow(row) : undefined;
  }

  // ---------- lists ----------

  async listLists(): Promise<List[]> {
    return (await this.db.lists.toArray()).sort(byCreation);
  }

  async getList(id: string): Promise<List | undefined> {
    return this.db.lists.get(id);
  }

  async createList(
    name: string,
    opts?: { preferColor?: string; sourceKey?: string },
  ): Promise<List> {
    const now = nowIso();
    return this.db.transaction("rw", [this.db.lists, this.db.views], async () => {
      const taken = await this.takenMarkers();
      const { marker } = assignMarker(taken, opts?.preferColor);
      const list: List = {
        id: newId(),
        name,
        marker,
        ...(opts?.sourceKey !== undefined ? { sourceKey: opts.sourceKey } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.db.lists.put(list);
      return list;
    });
  }

  async renameList(id: string, name: string): Promise<void> {
    await this.db.transaction("rw", [this.db.lists], async () => {
      const list = await this.db.lists.get(id);
      if (!list) throw new Error("list not found");
      await this.db.lists.put({ ...list, name, updatedAt: nowIso() });
    });
  }

  /** Markers worn by lists and saved views — one pair space for both. */
  private async takenMarkers(): Promise<ListMarker[]> {
    return [
      ...(await this.db.lists.toArray()).map((l) => l.marker),
      ...(await this.db.views.toArray()).map((v) => v.marker),
    ];
  }

  async setListDescription(id: string, description: string): Promise<void> {
    await this.db.transaction("rw", [this.db.lists], async () => {
      const list = await this.db.lists.get(id);
      if (!list) throw new Error("list not found");
      const { description: _old, ...rest } = list;
      const text = description.trim();
      await this.db.lists.put({
        ...rest,
        ...(text !== "" ? { description: text } : {}),
        updatedAt: nowIso(),
      });
    });
  }

  async setListMarker(id: string, marker: ListMarker): Promise<void> {
    await this.db.transaction("rw", [this.db.lists], async () => {
      const list = await this.db.lists.get(id);
      if (!list) throw new Error("list not found");
      // Manual change swaps within free pairs (spec/src/data-model.md §Normative rules).
      const clash = (await this.db.lists.toArray()).some(
        (other) => other.id !== id && markerKey(other.marker) === markerKey(marker),
      );
      if (clash) throw new Error("marker pair is worn by another list");
      await this.db.lists.put({ ...list, marker, updatedAt: nowIso() });
    });
  }

  async deleteList(id: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.lists, this.db.listEntries, this.db.posts, this.db.publications],
      async () => {
        const list = await this.db.lists.get(id);
        if (!list) return;
        const blockers: Blocker[] = [];
        const posts = await this.db.posts
          .where("targetKey")
          .equals(postTargetKey({ kind: "list", listId: id }))
          .toArray();
        if (posts.length > 0) {
          blockers.push({ kind: "list-has-posts", ids: posts.map((p) => p.id) });
        }
        const livePubs = (await this.publicationRowsFor({ kind: "list", id })).filter(
          (p) => p.revokedAt === undefined,
        );
        if (livePubs.length > 0) {
          blockers.push({ kind: "live-publication", ids: livePubs.map((p) => p.id) });
        }
        if (blockers.length > 0) {
          throw new TeardownRefusedError(
            "deleting this list is refused until its posts are deleted and it is unpublished",
            blockers,
          );
        }
        // The list goes; its places stay in the library.
        await this.db.listEntries.where("listId").equals(id).delete();
        await this.db.lists.delete(id);
      },
    );
  }

  async findListBySourceKey(key: string): Promise<List | undefined> {
    return this.db.lists.where("sourceKey").equals(key).first();
  }

  /**
   * The first import binds the source to the local list even when that list
   * already existed under the same name (spec/src/interop.md §Source-list
   * binding); an existing binding is never overwritten.
   */
  async setListSourceKey(id: string, sourceKey: string): Promise<void> {
    await this.db.transaction("rw", [this.db.lists], async () => {
      const list = await this.db.lists.get(id);
      if (!list) throw new Error("list not found");
      if (list.sourceKey !== undefined) return;
      await this.db.lists.put({ ...list, sourceKey, updatedAt: nowIso() });
    });
  }

  async findListByName(name: string): Promise<List | undefined> {
    const lists = await this.listLists();
    return (
      lists.find((l) => l.name === name) ??
      lists.find((l) => normalizeName(l.name) === normalizeName(name))
    );
  }

  // ---------- entries ----------

  private async orderedEntries(listId: string): Promise<ListEntryRow[]> {
    return (await this.db.listEntries.where("listId").equals(listId).toArray()).sort(compareByRank);
  }

  async entriesOf(listId: string): Promise<{ entry: ListEntry; place: Place }[]> {
    return this.db.transaction("r", [this.db.listEntries, this.db.places], async () => {
      const entries = await this.orderedEntries(listId);
      const views: { entry: ListEntry; place: Place }[] = [];
      for (const entry of entries) {
        const row = await this.db.places.get(entry.placeId);
        if (row) views.push({ entry, place: stripPlaceRow(row) });
      }
      return views;
    });
  }

  async addToList(listId: string, source: AddSource, opts?: AddOptions): Promise<AddResult> {
    const now = opts?.now ?? nowIso();
    return this.db.transaction(
      "rw",
      [this.db.lists, this.db.listEntries, this.db.places],
      async (): Promise<AddResult> => {
        if (!(await this.db.lists.get(listId))) throw new Error("list not found");

        let place: Place;
        if (source.kind === "existing") {
          const existing = await this.db.places.get(source.placeId);
          if (!existing) throw new Error("place not found");
          place = stripPlaceRow(existing);
        } else {
          const resolved = await this.resolvePlace(source.facts, now, opts?.forceNew === true);
          if (resolved.status === "conflict") {
            return { status: "name-proximity-conflict", existing: resolved.existing };
          }
          place = resolved.place;
        }

        // One live (listId, placeId) pair.
        const entries = await this.orderedEntries(listId);
        if (entries.some((e) => e.placeId === place.id)) {
          return { status: "already-member", place };
        }
        const last = entries.length > 0 ? (entries[entries.length - 1]?.rank ?? null) : null;
        const entry: ListEntry = {
          id: newId(),
          listId,
          placeId: place.id,
          rank: rankAfter(last),
          createdAt: now,
          updatedAt: now,
        };
        await this.db.listEntries.put(entry);
        return { status: "added", place };
      },
    );
  }

  async moveEntry(entryId: string, beforeEntryId: string | null): Promise<void> {
    await this.db.transaction("rw", [this.db.listEntries], async () => {
      const entry = await this.db.listEntries.get(entryId);
      if (!entry) throw new Error("entry not found");
      const siblings = (await this.orderedEntries(entry.listId)).filter((e) => e.id !== entryId);
      let rank: string;
      if (beforeEntryId === null) {
        rank = rankAfter(
          siblings.length > 0 ? (siblings[siblings.length - 1]?.rank ?? null) : null,
        );
      } else {
        const index = siblings.findIndex((e) => e.id === beforeEntryId);
        if (index === -1) throw new Error("target entry not found");
        const before = index > 0 ? (siblings[index - 1]?.rank ?? null) : null;
        rank = rankBetween(before, siblings[index]?.rank ?? null);
      }
      await this.db.listEntries.put({ ...entry, rank, updatedAt: nowIso() });
    });
  }

  async removeEntry(entryId: string): Promise<void> {
    // Leaving a list never deletes the place: the library owns it.
    await this.db.listEntries.delete(entryId);
  }

  async removeFromList(listId: string, placeId: PlaceId): Promise<void> {
    await this.db.listEntries.where("[listId+placeId]").equals([listId, placeId]).delete();
  }

  // ---------- saved views ----------

  async listViews(): Promise<SavedView[]> {
    return (await this.db.views.toArray()).sort(byCreation);
  }

  async createView(name: string, filter: PlaceFilter): Promise<SavedView> {
    const now = nowIso();
    return this.db.transaction("rw", [this.db.lists, this.db.views], async () => {
      const { marker } = assignMarker(await this.takenMarkers());
      const view: SavedView = {
        id: newId(),
        name: name.trim(),
        marker,
        filter: compactFilter(filter),
        createdAt: now,
        updatedAt: now,
      };
      await this.db.views.put(view);
      return view;
    });
  }

  async updateView(id: string, patch: { name?: string; filter?: PlaceFilter }): Promise<void> {
    await this.db.transaction("rw", [this.db.views], async () => {
      const view = await this.db.views.get(id);
      if (!view) throw new Error("view not found");
      await this.db.views.put({
        ...view,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.filter !== undefined ? { filter: compactFilter(patch.filter) } : {}),
        updatedAt: nowIso(),
      });
    });
  }

  async deleteView(id: string): Promise<void> {
    await this.db.views.delete(id);
  }

  // ---------- posts ----------

  async getPost(id: string): Promise<Post | undefined> {
    const row = await this.db.posts.get(id);
    return row ? stripPostRow(row) : undefined;
  }

  async postsFor(target: PostTarget): Promise<Post[]> {
    const rows = await this.db.posts.where("targetKey").equals(postTargetKey(target)).toArray();
    return rows.map(stripPostRow).sort(byCreation);
  }

  async allPosts(): Promise<Post[]> {
    return (await this.db.posts.toArray()).map(stripPostRow).sort(byCreation);
  }

  async createPost(target: PostTarget, title: string): Promise<Post> {
    const now = nowIso();
    return this.db.transaction("rw", [this.db.posts, this.db.lists, this.db.places], async () => {
      // Post-target existence: the target list or place must exist at creation.
      const exists =
        target.kind === "list"
          ? await this.db.lists.get(target.listId)
          : await this.db.places.get(target.placeId);
      if (!exists) throw new Error("post target not found");
      const post: Post = { id: newId(), target, title, body: "", createdAt: now, updatedAt: now };
      await this.db.posts.put(toPostRow(post));
      return post;
    });
  }

  /** The target is immutable after creation — there is deliberately no patch path for it. */
  async updatePost(id: string, patch: { title?: string; body?: string }): Promise<void> {
    await this.db.transaction("rw", [this.db.posts], async () => {
      const row = await this.db.posts.get(id);
      if (!row) throw new Error("post not found");
      await this.db.posts.put({
        ...row,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        updatedAt: nowIso(),
      });
    });
  }

  async deletePost(id: string): Promise<void> {
    await this.db.transaction("rw", [this.db.posts, this.db.publications], async () => {
      const row = await this.db.posts.get(id);
      if (!row) return;
      const livePubs = (await this.publicationRowsFor({ kind: "post", id })).filter(
        (p) => p.revokedAt === undefined,
      );
      if (livePubs.length > 0) {
        throw new TeardownRefusedError(
          "deleting a published post is refused until it is unpublished",
          [{ kind: "live-publication", ids: livePubs.map((p) => p.id) }],
        );
      }
      await this.db.posts.delete(id);
    });
  }

  // ---------- publications ----------

  private async publicationRowsFor(target: Publication["target"]): Promise<PublicationRow[]> {
    return this.db.publications.where("targetKey").equals(publicationTargetKey(target)).toArray();
  }

  /** The latest publication row for a target — live or revoked tombstone. */
  async publicationFor(target: Publication["target"]): Promise<Publication | undefined> {
    const rows = (await this.publicationRowsFor(target)).sort(byCreation);
    const last = rows[rows.length - 1];
    return last ? stripPublicationRow(last) : undefined;
  }

  async createPublication(
    target: Publication["target"],
    slug: string,
    editorToken: string,
    now: string,
  ): Promise<Publication> {
    const publication: Publication = {
      id: newId(),
      target,
      slug,
      editorToken,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.publications.put(toPublicationRow(publication));
    return publication;
  }

  async recordPublished(id: string, lastPublishedHash: string, now: string): Promise<void> {
    await this.db.transaction("rw", [this.db.publications], async () => {
      const row = await this.db.publications.get(id);
      if (!row) throw new Error("publication not found");
      await this.db.publications.put({
        ...row,
        lastPublishedHash,
        publishedAt: now,
        updatedAt: now,
      });
    });
  }

  /** Revoked rows persist as local tombstones; revoking again keeps the first revokedAt. */
  async markRevoked(id: string, now: string): Promise<void> {
    await this.db.transaction("rw", [this.db.publications], async () => {
      const row = await this.db.publications.get(id);
      if (!row) throw new Error("publication not found");
      if (row.revokedAt !== undefined) return;
      await this.db.publications.put({ ...row, revokedAt: now, updatedAt: now });
    });
  }

  async livePublications(): Promise<Publication[]> {
    const rows = await this.db.publications.toArray();
    return rows
      .filter((p) => p.revokedAt === undefined)
      .map(stripPublicationRow)
      .sort(byCreation);
  }

  // ---------- imports ----------

  async createImportBatch(b: ImportBatch): Promise<void> {
    await this.db.importBatches.put(b);
  }

  async getImportBatch(id: string): Promise<ImportBatch | undefined> {
    return this.db.importBatches.get(id);
  }

  async listImportBatches(): Promise<ImportBatch[]> {
    // Newest first — the review queue and report surface the latest import.
    return (await this.db.importBatches.toArray()).sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : byId(a, b),
    );
  }

  async setBatchStatus(id: string, status: ImportBatch["status"]): Promise<void> {
    await this.db.transaction("rw", [this.db.importBatches], async () => {
      const batch = await this.db.importBatches.get(id);
      if (!batch) throw new Error("import batch not found");
      await this.db.importBatches.put({ ...batch, status });
    });
  }

  async putImportItems(items: ImportItem[]): Promise<void> {
    await this.db.importItems.bulkPut(items);
  }

  async itemsOf(batchId: string): Promise<ImportItem[]> {
    return (await this.db.importItems.where("batchId").equals(batchId).toArray()).sort(byId);
  }

  async updateImportItem(item: ImportItem): Promise<void> {
    await this.db.importItems.put(item);
  }

  // ---------- settings ----------

  async getSetting<T>(key: string): Promise<T | undefined> {
    const row = await this.db.settings.get(key);
    return row === undefined ? undefined : (row.value as T);
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.settings.put({ key, value });
  }

  // ---------- archive ----------

  async exportLibrary(opts: { includeCredentials: boolean }): Promise<LibraryArchive> {
    return this.db.transaction(
      "r",
      [
        this.db.places,
        this.db.lists,
        this.db.listEntries,
        this.db.posts,
        this.db.publications,
        this.db.views,
      ],
      async () => {
        const publications = (await this.db.publications.toArray())
          .map(stripPublicationRow)
          .map((p): Publication => {
            if (opts.includeCredentials) return p;
            // Slugs are public anyway; the token is the only secret in the library.
            const { editorToken: _token, ...rest } = p;
            return rest;
          });
        return {
          v: 1 as const,
          kind: "placemarks-library" as const,
          exportedAt: nowIso(),
          places: (await this.db.places.toArray()).map(stripPlaceRow).sort(byId),
          lists: (await this.db.lists.toArray()).sort(byId),
          listEntries: (await this.db.listEntries.toArray()).sort(byId),
          posts: (await this.db.posts.toArray()).map(stripPostRow).sort(byId),
          publications: publications.sort(byId),
          views: (await this.db.views.toArray()).sort(byId),
        };
      },
    );
  }

  async importLibrary(a: LibraryArchive, now?: string): Promise<{ mode: "fresh" | "merge" }> {
    const stamp = now ?? nowIso();
    return this.db.transaction(
      "rw",
      [
        this.db.places,
        this.db.lists,
        this.db.listEntries,
        this.db.posts,
        this.db.publications,
        this.db.views,
      ],
      async () => {
        const incomingViews = a.views ?? [];
        const counts = await Promise.all([
          this.db.places.count(),
          this.db.lists.count(),
          this.db.listEntries.count(),
          this.db.posts.count(),
          this.db.publications.count(),
          this.db.views.count(),
        ]);
        const mode: "fresh" | "merge" = counts.every((c) => c === 0) ? "fresh" : "merge";

        if (mode === "fresh") {
          // Restore into an empty library: straight, id-preserving insert.
          await this.db.places.bulkPut(a.places.map(toPlaceRow));
          await this.db.lists.bulkPut(a.lists);
          await this.db.listEntries.bulkPut(a.listEntries);
          await this.db.posts.bulkPut(a.posts.map(toPostRow));
          await this.db.publications.bulkPut(a.publications.map(toPublicationRow));
          await this.db.views.bulkPut(incomingViews);
        } else {
          // Merge by id — same id = same entity, newer updatedAt wins.
          const changedListIds = new Set<string>();
          for (const incoming of a.places) {
            if (incomingWins(await this.db.places.get(incoming.id), incoming)) {
              await this.db.places.put(toPlaceRow(incoming));
            }
          }
          for (const incoming of a.lists) {
            if (incomingWins(await this.db.lists.get(incoming.id), incoming)) {
              await this.db.lists.put(incoming);
              changedListIds.add(incoming.id);
            }
          }
          for (const incoming of a.listEntries) {
            if (incomingWins(await this.db.listEntries.get(incoming.id), incoming)) {
              await this.db.listEntries.put(incoming);
            }
          }
          for (const incoming of a.posts) {
            if (incomingWins(await this.db.posts.get(incoming.id), incoming)) {
              await this.db.posts.put(toPostRow(incoming));
            }
          }
          for (const incoming of incomingViews) {
            if (incomingWins(await this.db.views.get(incoming.id), incoming)) {
              await this.db.views.put(incoming);
            }
          }
          for (const incoming of a.publications) {
            const existing = await this.db.publications.get(incoming.id);
            if (!incomingWins(existing, incoming)) continue;
            // A credential-less archive must not cost this device its publish
            // control: the stored token survives when the incoming row has none.
            const merged: Publication =
              incoming.editorToken === undefined && existing?.editorToken !== undefined
                ? { ...incoming, editorToken: existing.editorToken }
                : incoming;
            await this.db.publications.put(toPublicationRow(merged));
          }

          // Re-establish marker uniqueness: an incoming list whose pair is
          // already worn by a different live list is reassigned to the first
          // free pair (badged variant beyond 64).
          const lists = (await this.db.lists.toArray()).sort(byCreation);
          const worn = new Map<string, string>(); // markerKey → listId
          for (const list of lists.filter((l) => !changedListIds.has(l.id))) {
            worn.set(markerKey(list.marker), list.id);
          }
          for (const list of lists.filter((l) => changedListIds.has(l.id))) {
            const key = markerKey(list.marker);
            const holder = worn.get(key);
            if (holder === undefined || holder === list.id) {
              worn.set(key, list.id);
              continue;
            }
            const taken = (await this.db.lists.toArray())
              .filter((l) => l.id !== list.id)
              .map((l) => l.marker);
            const { marker } = assignMarker(taken);
            await this.db.lists.put({ ...list, marker, updatedAt: stamp });
            worn.set(markerKey(marker), list.id);
          }
        }

        // Re-check invariants (both modes; a valid archive is a no-op):
        // duplicate (listId, placeId) entries collapse to the (rank, id)-first
        // row, and entries pointing at a missing list or place are dropped.
        // Places on no list are kept: the library owns them.
        const allEntries = await this.db.listEntries.toArray();
        await this.db.listEntries.bulkDelete(duplicateEntryIds(allEntries));
        const listIds = new Set((await this.db.lists.toArray()).map((l) => l.id));
        const placeIds = new Set((await this.db.places.toArray()).map((p) => p.id));
        const orphaned = (await this.db.listEntries.toArray()).filter(
          (e) => !listIds.has(e.listId) || !placeIds.has(e.placeId),
        );
        await this.db.listEntries.bulkDelete(orphaned.map((e) => e.id));

        return { mode };
      },
    );
  }
}
