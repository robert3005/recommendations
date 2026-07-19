/**
 * DexieRepository — the LocalRepository implementation. Core rule
 * (book/src/data-model.md, 2026-07-18): **membership is existence** — a place
 * persists only while it belongs to at least one list. Cross-entity invariants
 * are enforced here, inside transactions:
 *  - a place appears at most once per list; losing its last membership removes
 *    the place with its tags and notes;
 *  - one live TagAssignment per (placeId, tagId); tag reuse by normalized name;
 *  - attachments join a place block to a note about the SAME PlaceId;
 *  - deletes tombstone dependents in the same transaction.
 */
import {
  type AddToListSource,
  allRefKeys,
  type BlockNoteAttachment,
  compareByRank,
  createImportedPlace,
  createManualPlace,
  createOsmPlace,
  displayFacts,
  distanceMeters,
  type ExternalRef,
  evidenceFromPoi,
  type GuideBlockView,
  hasExternalRef,
  type List,
  type ListBlock,
  linkPlaceToOsm,
  type ManualFacts,
  type MediaAsset,
  type Note,
  normalizeName,
  normalizeTagName,
  noteTargetKey,
  type OsmElementRef,
  type Place,
  type PlaceId,
  type PlacemarksRepository,
  type PlaceView,
  plausiblySameElement,
  type ResolvedPoi,
  rankAfter,
  rankBetween,
  refKey,
  sameRef,
  type Tag,
  type TagAssignment,
  withExternalRef,
} from "@placemarks/domain";
import { newId } from "../lib/id";
import { type ListBlockRow, type NoteRow, PlacemarksDb, type PlaceRow } from "./db";

function toPlaceRow(place: Place): PlaceRow {
  return { ...place, refKeys: allRefKeys(place) };
}

function toNoteRow(note: Note): NoteRow {
  return { ...note, targetKey: noteTargetKey(note.target) };
}

function toBlockRow(block: ListBlock): ListBlockRow {
  return {
    ...block,
    kind: block.content.type,
    refId: block.content.type === "section" ? block.content.noteId : block.content.placeId,
  };
}

const live = <T extends { deleted?: boolean }>(row: T | undefined): T | undefined =>
  row && !row.deleted ? row : undefined;

export class DexieRepository implements PlacemarksRepository {
  readonly db: PlacemarksDb;

  constructor(dbName?: string) {
    this.db = new PlacemarksDb(dbName);
  }

  // ---------- places ----------

  async getPlace(id: PlaceId): Promise<Place | undefined> {
    return live(await this.db.places.get(id));
  }

  async findPlaceByOsmRef(ref: OsmElementRef): Promise<Place | undefined> {
    // Never .first() + live(): a tombstoned row can shadow the live one.
    const rows = await this.db.places.where("refKeys").equals(refKey(ref)).toArray();
    return rows.find((row) => !row.deleted);
  }

  async updatePlace(place: Place): Promise<void> {
    // The guard reads and the write run in ONE transaction so concurrent
    // upgrades serialize — an exact OSM element can never fork across two
    // racing updates. The write and its publication dirtying also commit
    // together: a changed place changes every hosted guide containing it.
    await this.db.transaction(
      "rw",
      [
        this.db.places,
        this.db.listBlocks,
        this.db.lists,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        // Not a creation path: places come to exist through addToList only.
        const existing = live(await this.db.places.get(place.id));
        if (!existing) throw new Error("place not found — updatePlace is not a creation path");
        // One live PlaceId per exact OSM element: an upgrade that would fork
        // an element already held by another place is refused for explicit
        // review (book/src/place-identity.md).
        if (place.currentOsmRef) {
          const holder = await this.findPlaceByOsmRef(place.currentOsmRef);
          if (holder && holder.id !== place.id) {
            throw new Error(
              "another place already holds this exact OSM element — refusing to fork its identity",
            );
          }
        }
        // Durable identity is immutable at this boundary: origin and the
        // first observation never change, and completed link history is
        // strictly append-only — an update keeps its history only when the
        // existing entries survive verbatim as its prefix.
        const sameEntry = (
          a: Place["osmRefHistory"][number] | undefined,
          b: Place["osmRefHistory"][number] | undefined,
        ): boolean =>
          !!a &&
          !!b &&
          a.ref.type === b.ref.type &&
          a.ref.id === b.ref.id &&
          a.linkedAt === b.linkedAt &&
          a.unlinkedAt === b.unlinkedAt &&
          a.reason === b.reason;
        const preservesPrefix =
          place.osmRefHistory.length >= existing.osmRefHistory.length &&
          existing.osmRefHistory.every((entry, index) =>
            sameEntry(entry, place.osmRefHistory[index]),
          );
        await this.db.places.put(
          toPlaceRow({
            ...place,
            origin: existing.origin,
            ...(existing.firstSeen ? { firstSeen: existing.firstSeen } : {}),
            osmRefHistory: preservesPrefix ? place.osmRefHistory : existing.osmRefHistory,
          }),
        );
        for (const listId of await this.listIdsForPlace(place.id)) {
          await this.dirtyListPublications(listId, place.updatedAt);
        }
      },
    );
  }

  /**
   * Import dedup rung 1: the same Google listing id is the same place. Generic
   * "web" refs are provenance only — a chain's shared menu URL is not identity.
   */
  private async findByExternalRef(ref: ExternalRef): Promise<Place | undefined> {
    if (ref.provider !== "google-maps") return undefined;
    const rows = await this.db.places.toArray();
    return rows.find((row) => !row.deleted && hasExternalRef(row, ref));
  }

  /**
   * The place an import row would converge on: external-ref id, then the exact
   * OSM ref, then name+proximity — "ambiguous" when several nearby places share
   * the name and nothing stronger disambiguates (the importer sends those to
   * review instead of guessing).
   */
  async findImportTarget(
    facts: ManualFacts,
    externalRef?: ExternalRef,
    osmRef?: OsmElementRef,
    refIsAuthoritative = false,
  ): Promise<Place | "ambiguous" | undefined> {
    const byRef =
      (externalRef ? await this.findByExternalRef(externalRef) : undefined) ??
      (osmRef ? await this.findPlaceByOsmRef(osmRef) : undefined);
    if (byRef) return byRef;
    // An authoritative exact ref that matched nothing means a NEW place —
    // name+proximity must not fold it onto a different OSM element.
    if (refIsAuthoritative && osmRef) return undefined;
    return this.findByNameNearby(facts);
  }

  /**
   * Link an unlinked imported/manual place to its OSM match — origin, imported
   * facts, and external refs stay (book/src/interop.md: linkage is an upgrade,
   * never a new identity).
   */
  async linkImportedPlace(place: Place, poi: ResolvedPoi, now: string): Promise<Place> {
    const linked = place.currentOsmRef ? place : linkPlaceToOsm(place, poi, now, "resolver-match");
    await this.db.places.put(toPlaceRow(linked));
    return linked;
  }

  /**
   * Import dedup rung 3: same normalized name within 100 m. Coordinates alone
   * never dedup, and several equally-plausible targets are never chosen among
   * arbitrarily (mirrors the identity-matching rules in the domain).
   */
  private async findByNameNearby(facts: ManualFacts): Promise<Place | "ambiguous" | undefined> {
    const name = normalizeName(facts.name);
    if (!name) return undefined;
    const rows = await this.db.places.toArray();
    const matches = rows.filter((row) => {
      if (row.deleted) return false;
      // An OSM-linked place has a stronger identity than a name — an unlinked
      // imported anchor never folds onto it by name and coordinates alone.
      if (row.currentOsmRef) return false;
      const display = displayFacts(row);
      if (!display) return false;
      return (
        normalizeName(display.name) === name &&
        distanceMeters(display.lat, display.lng, facts.lat, facts.lng) <= 100
      );
    });
    if (matches.length > 1) return "ambiguous";
    return matches[0];
  }

  private async tagsOf(placeId: PlaceId): Promise<Tag[]> {
    const assignments = (
      await this.db.tagAssignments.where("placeId").equals(placeId).toArray()
    ).filter((a) => !a.deleted);
    const resolved = await Promise.all(
      assignments.map(async (a) => ({
        assignment: a,
        tag: await this.db.tags.get(a.tagId),
      })),
    );
    // Deterministic order: assignment time, then name — never index order.
    return resolved
      .filter((r): r is { assignment: TagAssignment; tag: Tag } => !!r.tag && !r.tag.deleted)
      .sort((a, b) =>
        a.assignment.createdAt < b.assignment.createdAt
          ? -1
          : a.assignment.createdAt > b.assignment.createdAt
            ? 1
            : a.tag.nameNorm < b.tag.nameNorm
              ? -1
              : 1,
      )
      .map((r) => r.tag);
  }

  private async livePlaceBlocks(placeId: PlaceId): Promise<ListBlockRow[]> {
    const liveListIds = new Set((await this.listLists()).map((l) => l.id));
    return (await this.db.listBlocks.where("refId").equals(placeId).toArray()).filter(
      (b) => !b.deleted && b.kind === "place" && liveListIds.has(b.listId),
    );
  }

  async listPlaces(): Promise<PlaceView[]> {
    const membership = await this.listMembershipByPlace();
    const views = await Promise.all(
      Object.keys(membership).map(async (placeId): Promise<PlaceView | undefined> => {
        const place = live(await this.db.places.get(placeId));
        if (!place) return undefined;
        return { place, tags: await this.tagsOf(placeId) };
      }),
    );
    return views.filter((v): v is PlaceView => v !== undefined);
  }

  async getPlaceView(placeId: PlaceId): Promise<PlaceView | undefined> {
    const place = live(await this.db.places.get(placeId));
    if (!place) return undefined;
    return { place, tags: await this.tagsOf(placeId) };
  }

  /**
   * A content change on a published list marks its hosted publication dirty
   * and coalesces one payload-less publish job — the outbox projects the
   * current document when it runs (book/src/sharing.md §Local publication
   * record: local edits queue; the public page never changes until a
   * successful publish).
   */
  private async dirtyListPublications(listId: string, now: string): Promise<void> {
    const publications = (await this.db.publications.toArray()).filter(
      (p) =>
        !p.deleted &&
        p.mode === "hosted" &&
        p.target.kind === "list" &&
        p.target.id === listId &&
        p.status !== "revoked" &&
        p.status !== "revoking",
    );
    for (const publication of publications) {
      const localRevision = `dirty:${now}:${newId()}`;
      await this.db.publications.put({
        ...publication,
        status: publication.status === "published" ? "queued" : publication.status,
        localRevision,
        updatedAt: now,
      });
      const pending = (await this.db.publicationOutbox.toArray()).find(
        (job) => job.publicationId === publication.id && job.action === "publish",
      );
      if (pending) {
        const { payload: _stale, ...rest } = pending;
        await this.db.publicationOutbox.put({ ...rest, payload: undefined, localRevision });
      } else {
        await this.db.publicationOutbox.put({
          id: newId(),
          publicationId: publication.id,
          action: "publish",
          payload: undefined,
          localRevision,
          createdAt: now,
          attempts: 0,
        });
      }
    }
  }

  /**
   * Queue revocation for every live hosted publication of a deleted target —
   * a deleted aggregate must never orphan its public page or credential
   * (book/src/sharing.md §Local publication record).
   */
  private async revokePublicationsFor(
    target: { kind: "list" | "note"; id: string },
    now: string,
  ): Promise<void> {
    const publications = (await this.db.publications.toArray()).filter(
      (p) =>
        !p.deleted &&
        p.mode === "hosted" &&
        p.target.kind === target.kind &&
        p.target.id === target.id &&
        p.status !== "revoked" &&
        p.status !== "revoking",
    );
    for (const publication of publications) {
      await this.db.publications.put({ ...publication, status: "revoking", updatedAt: now });
      const jobs = await this.db.publicationOutbox.toArray();
      for (const job of jobs) {
        if (job.publicationId === publication.id && job.action === "publish") {
          await this.db.publicationOutbox.delete(job.id);
        }
      }
      if (!jobs.some((j) => j.publicationId === publication.id && j.action === "revoke")) {
        await this.db.publicationOutbox.put({
          id: newId(),
          publicationId: publication.id,
          action: "revoke",
          localRevision: publication.localRevision,
          createdAt: now,
          attempts: 0,
        });
      }
    }
  }

  /** Tombstone the place with its tags, notes, and every membership block. */
  private async tombstonePlace(place: Place, now: string): Promise<void> {
    await this.db.places.put(toPlaceRow({ ...place, deleted: true, updatedAt: now }));
    const assignments = (
      await this.db.tagAssignments.where("placeId").equals(place.id).toArray()
    ).filter((a) => !a.deleted);
    for (const a of assignments) {
      await this.db.tagAssignments.put({ ...a, deleted: true, updatedAt: now });
    }
    const notes = (
      await this.db.notes.where("targetKey").equals(`place:${place.id}`).toArray()
    ).filter((n) => !n.deleted);
    for (const note of notes) {
      await this.tombstoneNote(note, now);
    }
    const blocks = (await this.db.listBlocks.where("refId").equals(place.id).toArray()).filter(
      (b) => !b.deleted && b.kind === "place",
    );
    for (const block of blocks) {
      await this.tombstoneBlock(block, now);
    }
  }

  async removePlace(placeId: PlaceId, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.places,
        this.db.tagAssignments,
        this.db.notes,
        this.db.listBlocks,
        this.db.blockNoteAttachments,
        this.db.lists,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const place = live(await this.db.places.get(placeId));
        if (!place) return;
        const listIds = await this.listIdsForPlace(placeId);
        await this.tombstonePlace(place, now);
        // Every hosted guide that contained the place re-projects without it.
        for (const listId of listIds) {
          await this.dirtyListPublications(listId, now);
        }
      },
    );
  }

  // ---------- tags ----------

  async listTags(): Promise<Tag[]> {
    return (await this.db.tags.toArray()).filter((t) => !t.deleted);
  }

  async assignTag(placeId: PlaceId, tagName: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.tags, this.db.tagAssignments, this.db.places],
      async () => {
        if (!live(await this.db.places.get(placeId))) {
          throw new Error("cannot tag: place not found");
        }
        const nameNorm = normalizeTagName(tagName);
        if (nameNorm === "") throw new Error("cannot tag: empty tag name");
        let tag = (await this.db.tags.where("nameNorm").equals(nameNorm).toArray()).find(
          (t) => !t.deleted,
        );
        if (!tag) {
          tag = { id: newId(), name: tagName.trim(), nameNorm, createdAt: now, updatedAt: now };
          await this.db.tags.put(tag);
        }
        const pair = await this.db.tagAssignments
          .where("[placeId+tagId]")
          .equals([placeId, tag.id])
          .toArray();
        if (pair.find((a) => !a.deleted)) return;
        const assignment: TagAssignment = {
          id: newId(),
          placeId,
          tagId: tag.id,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.tagAssignments.put(assignment);
      },
    );
  }

  async removeTagAssignment(placeId: PlaceId, tagId: string, now: string): Promise<void> {
    const pair = await this.db.tagAssignments
      .where("[placeId+tagId]")
      .equals([placeId, tagId])
      .toArray();
    const existing = pair.find((a) => !a.deleted);
    if (existing) {
      await this.db.tagAssignments.put({ ...existing, deleted: true, updatedAt: now });
    }
  }

  // ---------- notes ----------

  async listNotesForPlace(placeId: PlaceId): Promise<Note[]> {
    return (await this.db.notes.where("targetKey").equals(`place:${placeId}`).toArray()).filter(
      (n) => !n.deleted,
    );
  }

  async createNote(note: Note): Promise<void> {
    // A note attaches to a live aggregate — an orphan note is a graph error.
    const targetLive =
      note.target.kind === "place"
        ? live(await this.db.places.get(note.target.placeId))
        : live(await this.db.lists.get(note.target.listId));
    if (!targetLive)
      throw new Error("note target not found — notes attach to a live place or list");
    await this.db.notes.put(toNoteRow(note));
  }

  async updateNote(note: Note): Promise<void> {
    // The edit and every affected publication commit (or fail) as ONE
    // IndexedDB transaction — aggregate atomicity (book/src/storage-sync.md).
    await this.db.transaction(
      "rw",
      [
        this.db.notes,
        this.db.blockNoteAttachments,
        this.db.publications,
        this.db.publicationOutbox,
        this.db.listBlocks,
        this.db.lists,
        this.db.places,
      ],
      async () => {
        const oldRow = await this.db.notes.get(note.id);
        const wasShareable = oldRow?.shareable === true;
        // A retarget must land on a live aggregate — like creation, an update
        // never leaves a note targeting a missing row.
        if (oldRow && noteTargetKey(oldRow.target) !== noteTargetKey(note.target)) {
          const targetLive =
            note.target.kind === "place"
              ? live(await this.db.places.get(note.target.placeId))
              : live(await this.db.lists.get(note.target.listId));
          if (!targetLive) {
            throw new Error("note target not found — notes attach to a live place or list");
          }
        }
        // Retargeting invalidates every attachment made under the old target —
        // an attachment joins a block and note about the SAME place, so the edge
        // tombstones with the retarget rather than dangling inconsistently.
        if (oldRow && noteTargetKey(oldRow.target) !== noteTargetKey(note.target)) {
          const edges = (await this.db.blockNoteAttachments.toArray()).filter(
            (edge) => !edge.deleted && edge.noteId === note.id,
          );
          for (const edge of edges) {
            await this.db.blockNoteAttachments.put({
              ...edge,
              deleted: true,
              updatedAt: note.updatedAt,
            });
          }
        }
        if (!note.shareable) {
          // A note that stops being shareable queues removal of its public page
          // (book/src/notes.md): the old revision stays up until revocation
          // lands — and the revocation supersedes every pending page update.
          await this.revokePublicationsFor({ kind: "note", id: note.id }, note.updatedAt);
        }
        await this.db.notes.put(toNoteRow(note));
        if (note.shareable) {
          // A shareable-note edit dirties its standalone page AND every hosted
          // guide that contains it (book/src/sharing.md: mutating an attached
          // note queues every affected publication).
          const notePublications = (await this.db.publications.toArray()).filter(
            (p) =>
              !p.deleted &&
              p.mode === "hosted" &&
              p.target.kind === "note" &&
              p.target.id === note.id &&
              p.status !== "revoked" &&
              p.status !== "revoking",
          );
          for (const publication of notePublications) {
            const localRevision = `dirty:${note.updatedAt}:${newId()}`;
            await this.db.publications.put({
              ...publication,
              status: publication.status === "published" ? "queued" : publication.status,
              localRevision,
              updatedAt: note.updatedAt,
            });
            const pending = (await this.db.publicationOutbox.toArray()).find(
              (job) => job.publicationId === publication.id && job.action === "publish",
            );
            if (pending) {
              const { payload: _stale, ...rest } = pending;
              await this.db.publicationOutbox.put({ ...rest, payload: undefined, localRevision });
            } else {
              await this.db.publicationOutbox.put({
                id: newId(),
                publicationId: publication.id,
                action: "publish",
                payload: undefined,
                localRevision,
                createdAt: note.updatedAt,
                attempts: 0,
              });
            }
          }
        }
        // Any transition visible in a hosted guide dirties that guide — including
        // a shareable note going private (it disappears from the projection).
        if (note.shareable || wasShareable) {
          const listIds =
            note.target.kind === "list"
              ? [note.target.listId]
              : await this.listIdsForPlace(note.target.placeId);
          for (const listId of listIds) {
            await this.dirtyListPublications(listId, note.updatedAt);
          }
        }
      },
    );
  }

  private async tombstoneNote(note: Note, now: string): Promise<void> {
    await this.db.notes.put(toNoteRow({ ...note, deleted: true, updatedAt: now }));
    // A deleted note's standalone public page queues its removal.
    await this.revokePublicationsFor({ kind: "note", id: note.id }, now);
    // A deleted note disappears from every attachment…
    const attachments = (
      await this.db.blockNoteAttachments.where("noteId").equals(note.id).toArray()
    ).filter((a) => !a.deleted);
    for (const a of attachments) {
      await this.db.blockNoteAttachments.put({ ...a, deleted: true, updatedAt: now });
    }
    // …and a deleted section note removes its section block.
    if (note.target.kind === "list") {
      const blocks = (await this.db.listBlocks.where("refId").equals(note.id).toArray()).filter(
        (b) => !b.deleted && b.kind === "section",
      );
      for (const b of blocks) {
        await this.db.listBlocks.put({ ...b, deleted: true, updatedAt: now });
      }
    }
  }

  async deleteNote(noteId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.notes,
        this.db.blockNoteAttachments,
        this.db.listBlocks,
        this.db.lists,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const note = live(await this.db.notes.get(noteId));
        if (!note) return;
        await this.tombstoneNote(note, now);
        // The note vanishes from every hosted guide projection containing it.
        const listIds =
          note.target.kind === "list"
            ? [note.target.listId]
            : await this.listIdsForPlace(note.target.placeId);
        for (const listId of listIds) {
          await this.dirtyListPublications(listId, now);
        }
      },
    );
  }

  // ---------- media ----------

  async putMedia(asset: MediaAsset, blob: Blob): Promise<void> {
    await this.db.transaction("rw", [this.db.mediaAssets, this.db.mediaBlobs], async () => {
      await this.db.mediaAssets.put(asset);
      await this.db.mediaBlobs.put({ id: asset.localBlobKey, blob });
    });
  }

  async getMedia(id: string): Promise<{ asset: MediaAsset; blob: Blob } | undefined> {
    const asset = live(await this.db.mediaAssets.get(id));
    if (!asset) return undefined;
    const blobRow = await this.db.mediaBlobs.get(asset.localBlobKey);
    if (!blobRow) return undefined;
    return { asset, blob: blobRow.blob };
  }

  // ---------- lists ----------

  async listLists(): Promise<List[]> {
    return (await this.db.lists.toArray()).filter((l) => !l.deleted);
  }

  async getList(id: string): Promise<List | undefined> {
    const row = live(await this.db.lists.get(id));
    // Normalized shape: a live list is explicitly not tombstoned.
    return row ? { ...row, deleted: undefined } : undefined;
  }

  async createList(list: List): Promise<void> {
    await this.db.lists.put(list);
  }

  async updateList(list: List): Promise<void> {
    // The edit and its publication dirtying commit (or fail) together —
    // aggregate transactions (book/src/storage-sync.md).
    await this.db.transaction(
      "rw",
      [this.db.lists, this.db.publications, this.db.publicationOutbox],
      async () => {
        await this.db.lists.put(list);
        await this.dirtyListPublications(list.id, list.updatedAt);
      },
    );
  }

  private async tombstoneBlock(block: ListBlockRow, now: string): Promise<void> {
    await this.db.listBlocks.put({ ...block, deleted: true, updatedAt: now });
    const attachments = (
      await this.db.blockNoteAttachments.where("blockId").equals(block.id).toArray()
    ).filter((a) => !a.deleted);
    for (const a of attachments) {
      await this.db.blockNoteAttachments.put({ ...a, deleted: true, updatedAt: now });
    }
  }

  async deleteList(listId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.lists,
        this.db.listBlocks,
        this.db.blockNoteAttachments,
        this.db.notes,
        this.db.places,
        this.db.tagAssignments,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const list = live(await this.db.lists.get(listId));
        if (!list) return;
        await this.db.lists.put({ ...list, deleted: true, updatedAt: now });
        // The public guide comes down with the list — durably, not orphaned.
        await this.revokePublicationsFor({ kind: "list", id: listId }, now);
        const blocks = (await this.db.listBlocks.where("listId").equals(listId).toArray()).filter(
          (b) => !b.deleted,
        );
        for (const block of blocks) {
          await this.tombstoneBlock(block, now);
        }
        // Section notes belong to the list and die with it — including any
        // standalone public pages they had (tombstoneNote queues revocation).
        const sectionNotes = (
          await this.db.notes.where("targetKey").equals(`list:${listId}`).toArray()
        ).filter((n) => !n.deleted);
        for (const note of sectionNotes) {
          await this.tombstoneNote(note, now);
        }
        // Membership is existence: places whose only membership was here go too.
        for (const block of blocks.filter((b) => b.kind === "place")) {
          const remaining = await this.livePlaceBlocks(block.refId);
          if (remaining.length === 0) {
            const place = live(await this.db.places.get(block.refId));
            if (place) await this.tombstonePlace(place, now);
          }
        }
      },
    );
  }

  private async liveBlocks(listId: string): Promise<ListBlockRow[]> {
    const rows = (await this.db.listBlocks.where("listId").equals(listId).toArray()).filter(
      (b) => !b.deleted,
    );
    return rows.sort(compareByRank);
  }

  async getGuideBlocks(listId: string): Promise<GuideBlockView[]> {
    const blocks = await this.liveBlocks(listId);
    return Promise.all(
      blocks.map(async (block) => {
        if (block.content.type === "section") {
          const sectionNote = live(await this.db.notes.get(block.content.noteId));
          return { block, ...(sectionNote ? { sectionNote } : {}) };
        }
        const place = live(await this.db.places.get(block.content.placeId));
        const attachmentRows = (
          await this.db.blockNoteAttachments.where("blockId").equals(block.id).toArray()
        )
          .filter((a) => !a.deleted)
          .sort(compareByRank);
        const attachments = (
          await Promise.all(
            attachmentRows.map(
              async (
                attachment,
              ): Promise<{ attachment: BlockNoteAttachment; note: Note } | undefined> => {
                const note = live(await this.db.notes.get(attachment.noteId));
                return note ? { attachment, note } : undefined;
              },
            ),
          )
        ).filter((x): x is { attachment: BlockNoteAttachment; note: Note } => x !== undefined);
        return { block, ...(place ? { place } : {}), attachments };
      }),
    );
  }

  async listIdsForPlace(placeId: PlaceId): Promise<string[]> {
    return [...new Set((await this.livePlaceBlocks(placeId)).map((b) => b.listId))];
  }

  async listMembershipByPlace(): Promise<Record<string, string[]>> {
    const liveListIds = new Set((await this.listLists()).map((l) => l.id));
    const blocks = (await this.db.listBlocks.toArray()).filter(
      (b) => !b.deleted && b.kind === "place" && liveListIds.has(b.listId),
    );
    const membership: Record<string, string[]> = {};
    for (const block of blocks) {
      const existing = membership[block.refId] ?? [];
      existing.push(block.listId);
      membership[block.refId] = existing;
    }
    return membership;
  }

  async addToList(listId: string, source: AddToListSource, now: string): Promise<PlaceView> {
    // The edit and its publication dirtying commit (or fail) together —
    // aggregate transactions (book/src/storage-sync.md).
    return this.db.transaction(
      "rw",
      [
        this.db.lists,
        this.db.listBlocks,
        this.db.places,
        this.db.tagAssignments,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        if (!live(await this.db.lists.get(listId))) throw new Error("list not found");

        // Resolve or create the place — adding to a list is how it comes to exist.
        let place: Place;
        if (source.kind === "existing") {
          const existing = live(await this.db.places.get(source.placeId));
          if (!existing) throw new Error("place not found");
          place = existing;
        } else if (source.kind === "manual") {
          place = createManualPlace(newId(), source.facts, now);
          await this.db.places.put(toPlaceRow(place));
        } else if (source.kind === "import") {
          // Idempotent re-import (book/src/interop.md): external-ref id first,
          // then the OSM match's ref, then name+proximity — the same row
          // converges on the same place. An OSM match links the place but never
          // changes its import identity (origin, facts, external refs).
          const byRef =
            (source.externalRef ? await this.findByExternalRef(source.externalRef) : undefined) ??
            (source.poi ? await this.findPlaceByOsmRef(source.poi.osmRef) : undefined);
          const probed =
            byRef ??
            (source.authoritative === true && source.poi
              ? undefined
              : await this.findByNameNearby(source.facts));
          // Ambiguity at this level means "create a fresh place" — the importer
          // catches ambiguity earlier and routes the row to review instead.
          const found = probed === "ambiguous" ? undefined : probed;
          if (found) {
            let merged = source.externalRef
              ? withExternalRef(found, source.externalRef, now)
              : found;
            if (source.poi && !merged.currentOsmRef) {
              merged = linkPlaceToOsm(merged, source.poi, now, "resolver-match");
            }
            if (merged !== found) await this.db.places.put(toPlaceRow(merged));
            place = merged;
          } else {
            place = createImportedPlace(newId(), source.facts, source.externalRef, now);
            if (source.poi) place = linkPlaceToOsm(place, source.poi, now, "resolver-match");
            await this.db.places.put(toPlaceRow(place));
          }
        } else {
          const poi: ResolvedPoi = source.poi;
          const found = (
            await this.db.places.where("refKeys").equals(refKey(poi.osmRef)).toArray()
          ).find((row) => !row.deleted);
          if (found) {
            // Current-ref match refreshes evidence; a historical-ref match means
            // the element was replaced — reuse the place, keep the newer binding.
            if (found.currentOsmRef && sameRef(found.currentOsmRef, poi.osmRef)) {
              if (found.lastVerified && !plausiblySameElement(found.lastVerified, poi)) {
                // The element id survives but the observation no longer looks
                // like the same real-world place (repurposed id). Keep the
                // copied evidence untouched and flag for explicit review —
                // never silently overwrite what the user saved.
                place = {
                  ...found,
                  resolutionState: "needs-review",
                  lastResolutionAttemptAt: now,
                  updatedAt: now,
                };
              } else {
                place = {
                  ...found,
                  lastVerified: evidenceFromPoi(poi),
                  resolutionState: "resolved",
                  lastResolutionAttemptAt: now,
                  updatedAt: now,
                };
              }
              await this.db.places.put(toPlaceRow(place));
            } else {
              place = found;
            }
          } else {
            place = createOsmPlace(newId(), poi, now);
            await this.db.places.put(toPlaceRow(place));
          }
          // An import that OSM-matched still retains its source URL (provenance
          // and the deep link back — book/src/interop.md).
          if (source.externalRef && !hasExternalRef(place, source.externalRef)) {
            place = withExternalRef(place, source.externalRef, now);
            await this.db.places.put(toPlaceRow(place));
          }
        }

        const blocks = await this.liveBlocks(listId);
        // A place may appear at most once in a list.
        if (blocks.some((b) => b.kind === "place" && b.refId === place.id)) {
          throw new Error("place already in this list");
        }
        const lastRank = blocks.length > 0 ? (blocks[blocks.length - 1]?.rank ?? null) : null;
        const block: ListBlock = {
          id: newId(),
          listId,
          rank: rankAfter(lastRank),
          content: { type: "place", placeId: place.id },
          createdAt: now,
          updatedAt: now,
        };
        await this.db.listBlocks.put(toBlockRow(block));
        await this.dirtyListPublications(listId, now);
        return { place, tags: await this.tagsOf(place.id) };
      },
    );
  }

  async addSectionBlock(
    listId: string,
    body: string,
    now: string,
    title?: string,
  ): Promise<ListBlock> {
    return this.db.transaction(
      "rw",
      [this.db.lists, this.db.listBlocks, this.db.notes],
      async () => {
        if (!live(await this.db.lists.get(listId))) throw new Error("list not found");
        const note: Note = {
          id: newId(),
          target: { kind: "list", listId },
          ...(title ? { title } : {}),
          body,
          mediaIds: [],
          shareable: false,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.notes.put(toNoteRow(note));
        const blocks = await this.liveBlocks(listId);
        const lastRank = blocks.length > 0 ? (blocks[blocks.length - 1]?.rank ?? null) : null;
        const block: ListBlock = {
          id: newId(),
          listId,
          rank: rankAfter(lastRank),
          content: { type: "section", noteId: note.id },
          createdAt: now,
          updatedAt: now,
        };
        await this.db.listBlocks.put(toBlockRow(block));
        return block;
      },
    );
  }

  async moveBlock(blockId: string, beforeBlockId: string | null, now: string): Promise<void> {
    // The reorder and its publication dirtying commit (or fail) together.
    await this.db.transaction(
      "rw",
      [this.db.listBlocks, this.db.lists, this.db.publications, this.db.publicationOutbox],
      async () => {
        const block = live(await this.db.listBlocks.get(blockId));
        if (!block) throw new Error("block not found");
        const siblings = (await this.liveBlocks(block.listId)).filter((b) => b.id !== blockId);
        let rank: string;
        if (beforeBlockId === null) {
          rank = rankAfter(
            siblings.length > 0 ? (siblings[siblings.length - 1]?.rank ?? null) : null,
          );
        } else {
          const index = siblings.findIndex((b) => b.id === beforeBlockId);
          if (index === -1) throw new Error("target block not found");
          const before = index > 0 ? (siblings[index - 1]?.rank ?? null) : null;
          rank = rankBetween(before, siblings[index]?.rank ?? null);
        }
        await this.db.listBlocks.put({ ...block, rank, updatedAt: now });
        await this.dirtyListPublications(block.listId, now);
      },
    );
  }

  async removeBlock(blockId: string, now: string): Promise<void> {
    // The removal cascade and its publication dirtying are one commit.
    await this.db.transaction(
      "rw",
      [
        this.db.listBlocks,
        this.db.blockNoteAttachments,
        this.db.notes,
        this.db.places,
        this.db.tagAssignments,
        this.db.lists,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const touched = live(await this.db.listBlocks.get(blockId))?.listId;
        await this.removeBlockInner(blockId, now);
        if (touched) await this.dirtyListPublications(touched, now);
      },
    );
  }

  private async removeBlockInner(blockId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.listBlocks,
        this.db.blockNoteAttachments,
        this.db.notes,
        this.db.places,
        this.db.tagAssignments,
        this.db.lists,
      ],
      async () => {
        const block = live(await this.db.listBlocks.get(blockId));
        if (!block) return;
        await this.tombstoneBlock(block, now);
        // A removed section block takes its list-owned note with it.
        if (block.content.type === "section") {
          const note = live(await this.db.notes.get(block.content.noteId));
          if (note) {
            await this.db.notes.put(toNoteRow({ ...note, deleted: true, updatedAt: now }));
          }
          return;
        }
        // Membership is existence: dropping the last membership removes the place.
        const remaining = await this.livePlaceBlocks(block.content.placeId);
        if (remaining.length === 0) {
          const place = live(await this.db.places.get(block.content.placeId));
          if (place) await this.tombstonePlace(place, now);
        }
      },
    );
  }

  async attachNoteToBlock(
    blockId: string,
    noteId: string,
    now: string,
  ): Promise<BlockNoteAttachment> {
    return this.db.transaction(
      "rw",
      [this.db.listBlocks, this.db.notes, this.db.blockNoteAttachments],
      async () => {
        const block = live(await this.db.listBlocks.get(blockId));
        if (block?.content.type !== "place") {
          throw new Error("attachments require a place block");
        }
        const note = live(await this.db.notes.get(noteId));
        if (!note) throw new Error("note not found");
        // Attaching puts the note into the guide — only shareable notes may
        // enter a shareable surface (book/src/notes.md §Share eligibility).
        if (!note.shareable) {
          throw new Error("only shareable notes can be attached to a guide block");
        }
        // The invariant: an attached note is about the SAME place as the block.
        if (note.target.kind !== "place" || note.target.placeId !== block.content.placeId) {
          throw new Error("note targets a different place than this block");
        }
        const pair = await this.db.blockNoteAttachments
          .where("[blockId+noteId]")
          .equals([blockId, noteId])
          .toArray();
        const existing = pair.find((a) => !a.deleted);
        if (existing) return existing;
        const attachments = (
          await this.db.blockNoteAttachments.where("blockId").equals(blockId).toArray()
        )
          .filter((a) => !a.deleted)
          .sort(compareByRank);
        const lastRank =
          attachments.length > 0 ? (attachments[attachments.length - 1]?.rank ?? null) : null;
        const attachment: BlockNoteAttachment = {
          id: newId(),
          blockId,
          noteId,
          rank: rankAfter(lastRank),
          createdAt: now,
          updatedAt: now,
        };
        await this.db.blockNoteAttachments.put(attachment);
        return attachment;
      },
    );
  }

  async detachNoteFromBlock(blockId: string, noteId: string, now: string): Promise<void> {
    const pair = await this.db.blockNoteAttachments
      .where("[blockId+noteId]")
      .equals([blockId, noteId])
      .toArray();
    const existing = pair.find((a) => !a.deleted);
    if (existing) {
      await this.db.blockNoteAttachments.put({ ...existing, deleted: true, updatedAt: now });
    }
  }
}
