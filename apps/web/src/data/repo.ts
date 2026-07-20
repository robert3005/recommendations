/**
 * DexieRepository — the LocalRepository implementation. Core rules
 * (spec/src/data-model.md):
 *  - **membership is existence** (2026-07-18): a place persists only while it
 *    belongs to at least one list;
 *  - **bottom-up teardown** (2026-07-19, late): deletion never cascades through
 *    authored content — removals are refused, with blockers named, until the
 *    owner has dismantled what hangs off the target. Pure edges (tag
 *    assignments, tag selections) cascade; written content never does;
 *  - lists carry membership only; the editorial layer is the Post aggregate;
 *  - live list markers are unique (colour, icon) pairs.
 * Cross-entity invariants are enforced here, inside transactions:
 *  - a place appears at most once per list and per post;
 *  - one live TagAssignment per (placeId, tagId); tag reuse by normalized name;
 *  - a section note targets the same post as its section block;
 *  - a live place embed's place is a live member of the post's list;
 *  - attachments join a post place block to a shareable note about the SAME
 *    PlaceId; selections join it to a tag assigned to that place;
 *  - live (blockId, noteId) and (blockId, tagId) edges are unique.
 */
import {
  type AddToListSource,
  allRefKeys,
  type BlockNoteAttachment,
  type BlockTagSelection,
  compareByRank,
  createImportedPlace,
  createManualPlace,
  createOsmPlace,
  displayFacts,
  distanceMeters,
  type ExternalRef,
  emptyBlockers,
  evidenceFromPoi,
  hasBlockers,
  hasExternalRef,
  type List,
  type ListBlock,
  type ListBlockView,
  linkPlaceToOsm,
  type ManualFacts,
  type MediaAsset,
  markerKey,
  type Note,
  normalizeName,
  normalizeTagName,
  noteTargetKey,
  type OsmElementRef,
  type Place,
  type PlaceId,
  type PlacemarksRepository,
  type PlaceView,
  type Post,
  type PostBlock,
  type PostBlockView,
  plausiblySameElement,
  type ResolvedPoi,
  rankAfter,
  rankBetween,
  refKey,
  sameRef,
  type Tag,
  type TagAssignment,
  type TeardownBlockers,
  TeardownRefusedError,
  withExternalRef,
} from "@placemarks/domain";
import { newId } from "../lib/id";
import {
  type ListBlockRow,
  type NoteRow,
  PlacemarksDb,
  type PlaceRow,
  type PostBlockRow,
} from "./db";

function toPlaceRow(place: Place): PlaceRow {
  return { ...place, refKeys: allRefKeys(place) };
}

function toNoteRow(note: Note): NoteRow {
  return { ...note, targetKey: noteTargetKey(note.target) };
}

function toBlockRow(block: ListBlock): ListBlockRow {
  return { ...block, kind: "place", refId: block.content.placeId };
}

function toPostBlockRow(block: PostBlock): PostBlockRow {
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
    // together: a changed place changes every hosted list containing it and
    // every hosted post embedding it.
    await this.db.transaction(
      "rw",
      [
        this.db.places,
        this.db.listBlocks,
        this.db.lists,
        this.db.posts,
        this.db.postBlocks,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        // A whole-object update is never a deletion: removals go through the
        // teardown-guarded removePlace/removeBlock cascades only.
        if (place.deleted) {
          throw new Error("updatePlace cannot delete — removals go through removePlace");
        }
        // Not a creation path: places come to exist through addToList only.
        const existing = live(await this.db.places.get(place.id));
        if (!existing) throw new Error("place not found — updatePlace is not a creation path");
        // One live PlaceId per exact OSM element: an upgrade that would fork
        // an element already held by another place is refused for explicit
        // review (spec/src/place-identity.md).
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
        // A binding transition and its history move together: changing the
        // current ref REQUIRES appending the completed prior interval, and
        // history may only grow with a real transition (an unlinked place may
        // still record provenance history). Anything else preserves existing.
        const refChanged = !(
          (existing.currentOsmRef === undefined && place.currentOsmRef === undefined) ||
          (existing.currentOsmRef !== undefined &&
            place.currentOsmRef !== undefined &&
            sameRef(existing.currentOsmRef, place.currentOsmRef))
        );
        const grown = preservesPrefix && place.osmRefHistory.length > existing.osmRefHistory.length;
        // The ONLY valid growth alongside a binding change is the single
        // domain-produced interval closing the prior binding — arbitrary
        // extra entries riding an otherwise-real transition are forged
        // history, and losing the binding outright never happens: linkage
        // only ever gains or replaces OSM identity.
        const tail = place.osmRefHistory.slice(existing.osmRefHistory.length);
        const tailIsExactClosure =
          grown &&
          tail.length === 1 &&
          existing.currentOsmRef !== undefined &&
          tail[0] !== undefined &&
          sameRef(tail[0].ref, existing.currentOsmRef) &&
          tail[0].linkedAt === existing.currentOsmLinkedAt &&
          tail[0].unlinkedAt !== undefined;
        const growthValid =
          grown &&
          ((refChanged && place.currentOsmRef !== undefined && tailIsExactClosure) ||
            (existing.currentOsmRef === undefined && place.currentOsmRef === undefined));
        const nextHistory = growthValid
          ? place.osmRefHistory
          : preservesPrefix && !grown
            ? place.osmRefHistory
            : existing.osmRefHistory;
        const acceptRef =
          !refChanged ||
          existing.currentOsmRef === undefined ||
          (place.currentOsmRef !== undefined && growthValid);
        await this.db.places.put(
          toPlaceRow({
            ...place,
            origin: existing.origin,
            ...(existing.firstSeen ? { firstSeen: existing.firstSeen } : {}),
            osmRefHistory: nextHistory,
            ...(acceptRef
              ? {}
              : {
                  currentOsmRef: existing.currentOsmRef,
                  currentOsmLinkedAt: existing.currentOsmLinkedAt,
                  lastVerified: existing.lastVerified,
                  resolutionState: existing.resolutionState,
                }),
          }),
        );
        for (const listId of await this.listIdsForPlace(place.id)) {
          await this.dirtyListPublications(listId, place.updatedAt);
        }
        for (const postId of await this.postIdsEmbedding(place.id)) {
          await this.dirtyPostPublications(postId, place.updatedAt);
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
   * facts, and external refs stay (spec/src/interop.md: linkage is an upgrade,
   * never a new identity). The fork guard and the write run in ONE
   * transaction so concurrent upgrades serialize: an exact OSM element can
   * never gain two live holders.
   */
  async linkImportedPlace(place: Place, poi: ResolvedPoi, now: string): Promise<Place> {
    return this.db.transaction("rw", [this.db.places], async () => {
      const current = live(await this.db.places.get(place.id)) ?? place;
      if (current.currentOsmRef) return current;
      const holder = await this.findPlaceByOsmRef(poi.osmRef);
      if (holder && holder.id !== current.id) {
        // Another live place already holds this exact element — linking would
        // fork its identity, so this upgrade quietly stands down.
        return current;
      }
      const linked = linkPlaceToOsm(current, poi, now, "resolver-match");
      await this.db.places.put(toPlaceRow(linked));
      return linked;
    });
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

  /** Live post place blocks embedding this place, joined with their live posts. */
  private async liveEmbedsOfPlace(
    placeId: PlaceId,
  ): Promise<{ block: PostBlockRow; post: Post }[]> {
    const rows = (await this.db.postBlocks.where("refId").equals(placeId).toArray()).filter(
      (b) => !b.deleted && b.kind === "place",
    );
    const result: { block: PostBlockRow; post: Post }[] = [];
    for (const block of rows) {
      const post = live(await this.db.posts.get(block.postId));
      if (post) result.push({ block, post });
    }
    return result;
  }

  private async postIdsEmbedding(placeId: PlaceId): Promise<string[]> {
    return [...new Set((await this.liveEmbedsOfPlace(placeId)).map((e) => e.post.id))];
  }

  private async liveNotesOfPlace(placeId: PlaceId): Promise<NoteRow[]> {
    return (await this.db.notes.where("targetKey").equals(`place:${placeId}`).toArray()).filter(
      (n) => !n.deleted,
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
   * current document when it runs (spec/src/sharing.md §Local publication
   * record: local edits queue; the public page never changes until a
   * successful publish).
   */
  private async dirtyListPublications(listId: string, now: string): Promise<void> {
    await this.dirtyPublicationsFor({ kind: "list", id: listId }, now);
  }

  /** A post edit dirties that post's hosted publications the same way. */
  private async dirtyPostPublications(postId: string, now: string): Promise<void> {
    await this.dirtyPublicationsFor({ kind: "post", id: postId }, now);
  }

  private async dirtyPublicationsFor(
    target: { kind: "list" | "post" | "note"; id: string },
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
   * (spec/src/sharing.md §Local publication record).
   */
  private async revokePublicationsFor(
    target: { kind: "list" | "post" | "note"; id: string },
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

  /**
   * Tombstone the place with its pure edges — tag assignments and membership
   * blocks. Bottom-up teardown guarantees no live notes or embeds exist by the
   * time this runs; authored content never dies as a side effect.
   */
  private async tombstonePlace(place: Place, now: string): Promise<void> {
    await this.db.places.put(toPlaceRow({ ...place, deleted: true, updatedAt: now }));
    const assignments = (
      await this.db.tagAssignments.where("placeId").equals(place.id).toArray()
    ).filter((a) => !a.deleted);
    for (const a of assignments) {
      await this.db.tagAssignments.put({ ...a, deleted: true, updatedAt: now });
    }
    const blocks = (await this.db.listBlocks.where("refId").equals(place.id).toArray()).filter(
      (b) => !b.deleted && b.kind === "place",
    );
    for (const block of blocks) {
      await this.db.listBlocks.put({ ...block, deleted: true, updatedAt: now });
    }
  }

  /**
   * Blockers for ending this place's existence (spec/src/posts.md §Where
   * embeds come from): live notes on the place and live post embeds of it.
   */
  private async placeRemovalBlockers(placeId: PlaceId): Promise<TeardownBlockers> {
    const blockers = emptyBlockers();
    for (const note of await this.liveNotesOfPlace(placeId)) {
      blockers.notes.push({
        placeId,
        noteId: note.id,
        ...(note.title !== undefined ? { title: note.title } : {}),
      });
    }
    for (const embed of await this.liveEmbedsOfPlace(placeId)) {
      blockers.embeds.push({
        placeId,
        postId: embed.post.id,
        postTitle: embed.post.title,
        blockId: embed.block.id,
      });
    }
    return blockers;
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
        this.db.blockTagSelections,
        this.db.lists,
        this.db.posts,
        this.db.postBlocks,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const place = live(await this.db.places.get(placeId));
        if (!place) return;
        // Removing the place from every list ends its existence — refused
        // while authored content still hangs off it (bottom-up teardown).
        const blockers = await this.placeRemovalBlockers(placeId);
        if (hasBlockers(blockers)) {
          throw new TeardownRefusedError(
            "removing this place is blocked — delete its notes and post embeds first",
            blockers,
          );
        }
        const listIds = await this.listIdsForPlace(placeId);
        await this.tombstonePlace(place, now);
        // Every hosted list that contained the place re-projects without it.
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
    // Pure edges cascade: dropping the assignment drops every publication
    // selection that depended on it, in the same transaction, and re-projects
    // the affected posts.
    await this.db.transaction(
      "rw",
      [
        this.db.tagAssignments,
        this.db.blockTagSelections,
        this.db.postBlocks,
        this.db.posts,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const pair = await this.db.tagAssignments
          .where("[placeId+tagId]")
          .equals([placeId, tagId])
          .toArray();
        const existing = pair.find((a) => !a.deleted);
        if (!existing) return;
        await this.db.tagAssignments.put({ ...existing, deleted: true, updatedAt: now });
        const selections = (
          await this.db.blockTagSelections.where("tagId").equals(tagId).toArray()
        ).filter((s) => !s.deleted);
        const touchedPosts = new Set<string>();
        for (const selection of selections) {
          const block = live(await this.db.postBlocks.get(selection.blockId));
          if (block && block.kind === "place" && block.refId === placeId) {
            await this.db.blockTagSelections.put({ ...selection, deleted: true, updatedAt: now });
            touchedPosts.add(block.postId);
          }
        }
        for (const postId of touchedPosts) {
          await this.dirtyPostPublications(postId, now);
        }
      },
    );
  }

  // ---------- notes ----------

  async listNotesForPlace(placeId: PlaceId): Promise<Note[]> {
    return (await this.db.notes.where("targetKey").equals(`place:${placeId}`).toArray()).filter(
      (n) => !n.deleted,
    );
  }

  private async noteTargetIsLive(note: Note): Promise<boolean> {
    return note.target.kind === "place"
      ? live(await this.db.places.get(note.target.placeId)) !== undefined
      : live(await this.db.posts.get(note.target.postId)) !== undefined;
  }

  async createNote(note: Note): Promise<void> {
    // A note attaches to a live aggregate — an orphan note is a graph error.
    if (!(await this.noteTargetIsLive(note))) {
      throw new Error("note target not found — notes attach to a live place or post");
    }
    await this.db.notes.put(toNoteRow(note));
  }

  async updateNote(note: Note): Promise<void> {
    // The edit and every affected publication commit (or fail) as ONE
    // IndexedDB transaction — aggregate atomicity (spec/src/storage-sync.md).
    await this.db.transaction(
      "rw",
      [
        this.db.notes,
        this.db.blockNoteAttachments,
        this.db.publications,
        this.db.publicationOutbox,
        this.db.listBlocks,
        this.db.lists,
        this.db.posts,
        this.db.postBlocks,
        this.db.places,
      ],
      async () => {
        // A whole-object update is never a deletion: only deleteNote runs the
        // tombstone cascade (attachments, section blocks, page revocation).
        if (note.deleted) {
          throw new Error("updateNote cannot delete — removals go through deleteNote");
        }
        const oldRow = await this.db.notes.get(note.id);
        // Not a creation path, and never a resurrection: updates apply only
        // to live existing notes.
        if (!oldRow || oldRow.deleted) {
          throw new Error("note not found — updateNote is not a creation path");
        }
        const wasShareable = oldRow.shareable === true;
        const retargeted = noteTargetKey(oldRow.target) !== noteTargetKey(note.target);
        // A retarget must land on a live aggregate — like creation, an update
        // never leaves a note targeting a missing row.
        if (retargeted && !(await this.noteTargetIsLive(note))) {
          throw new Error("note target not found — notes attach to a live place or post");
        }
        // Retargeting invalidates every attachment made under the old target —
        // an attachment joins a block and note about the SAME place, so the edge
        // tombstones with the retarget rather than dangling inconsistently.
        const attachedBlockIds: string[] = [];
        if (retargeted) {
          const edges = (await this.db.blockNoteAttachments.toArray()).filter(
            (edge) => !edge.deleted && edge.noteId === note.id,
          );
          for (const edge of edges) {
            attachedBlockIds.push(edge.blockId);
            await this.db.blockNoteAttachments.put({
              ...edge,
              deleted: true,
              updatedAt: note.updatedAt,
            });
          }
        }
        if (!note.shareable) {
          // A note that stops being shareable queues removal of its public page
          // (spec/src/notes.md): the old revision stays up until revocation
          // lands — and the revocation supersedes every pending page update.
          await this.revokePublicationsFor({ kind: "note", id: note.id }, note.updatedAt);
        }
        await this.db.notes.put(toNoteRow(note));
        if (note.shareable) {
          // A shareable-note edit dirties its standalone page too.
          await this.dirtyPublicationsFor({ kind: "note", id: note.id }, note.updatedAt);
        }
        // Any transition visible in a hosted projection dirties it — including
        // a shareable note going private (it disappears), and the OLD
        // containers when a retarget happens in the same edit.
        const touchedLists = new Set<string>();
        const touchedPosts = new Set<string>();
        for (const target of [note.target, oldRow.target]) {
          if (target.kind === "post") {
            // A post section note is part of the post's article regardless of
            // shareability of other notes; its edit re-projects the post.
            touchedPosts.add(target.postId);
          } else if (note.shareable || wasShareable) {
            // Shareable place notes ride along in list projections
            // (spec/src/sharing.md §First-release simplifications) and enter
            // posts through explicit attachments.
            for (const id of await this.listIdsForPlace(target.placeId)) touchedLists.add(id);
            for (const embed of await this.liveEmbedsOfPlace(target.placeId)) {
              touchedPosts.add(embed.post.id);
            }
          }
        }
        // Blocks that lost this note's attachment through a retarget.
        for (const blockId of attachedBlockIds) {
          const block = await this.db.postBlocks.get(blockId);
          if (block && !block.deleted) touchedPosts.add(block.postId);
        }
        for (const listId of touchedLists) {
          await this.dirtyListPublications(listId, note.updatedAt);
        }
        for (const postId of touchedPosts) {
          await this.dirtyPostPublications(postId, note.updatedAt);
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
    // …and a deleted post-section note removes its section block.
    if (note.target.kind === "post") {
      const blocks = (await this.db.postBlocks.where("refId").equals(note.id).toArray()).filter(
        (b) => !b.deleted && b.kind === "section",
      );
      for (const b of blocks) {
        await this.db.postBlocks.put({ ...b, deleted: true, updatedAt: now });
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
        this.db.posts,
        this.db.postBlocks,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const note = live(await this.db.notes.get(noteId));
        if (!note) return;
        // Blocks that carried this note re-project without it.
        const attachedPostIds = new Set<string>();
        const edges = (
          await this.db.blockNoteAttachments.where("noteId").equals(noteId).toArray()
        ).filter((a) => !a.deleted);
        for (const edge of edges) {
          const block = await this.db.postBlocks.get(edge.blockId);
          if (block && !block.deleted) attachedPostIds.add(block.postId);
        }
        await this.tombstoneNote(note, now);
        // The note vanishes from every hosted projection containing it.
        if (note.target.kind === "post") {
          await this.dirtyPostPublications(note.target.postId, now);
        } else {
          for (const listId of await this.listIdsForPlace(note.target.placeId)) {
            await this.dirtyListPublications(listId, now);
          }
          for (const embed of await this.liveEmbedsOfPlace(note.target.placeId)) {
            attachedPostIds.add(embed.post.id);
          }
        }
        for (const postId of attachedPostIds) {
          await this.dirtyPostPublications(postId, now);
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

  /** Live markers are unique (colour, icon) pairs (spec/src/data-model.md §List). */
  private async assertMarkerFree(list: List): Promise<void> {
    const key = markerKey(list.marker);
    const clash = (await this.listLists()).find(
      (other) => other.id !== list.id && markerKey(other.marker) === key,
    );
    if (clash) {
      throw new Error(`marker already in use by list "${clash.name}" — markers are unique`);
    }
  }

  async createList(list: List): Promise<void> {
    await this.db.transaction("rw", [this.db.lists], async () => {
      await this.assertMarkerFree(list);
      await this.db.lists.put(list);
    });
  }

  async updateList(list: List): Promise<void> {
    // The edit and its publication dirtying commit (or fail) together —
    // aggregate transactions (spec/src/storage-sync.md).
    await this.db.transaction(
      "rw",
      [this.db.lists, this.db.posts, this.db.publications, this.db.publicationOutbox],
      async () => {
        const existing = live(await this.db.lists.get(list.id));
        await this.assertMarkerFree(list);
        await this.db.lists.put(list);
        await this.dirtyListPublications(list.id, list.updatedAt);
        // A shared post names its list — a rename re-projects the posts too.
        if (existing && existing.name !== list.name) {
          for (const post of await this.listPostsForList(list.id)) {
            await this.dirtyPostPublications(post.id, list.updatedAt);
          }
        }
      },
    );
  }

  async deleteList(listId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.lists,
        this.db.listBlocks,
        this.db.posts,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const list = live(await this.db.lists.get(listId));
        if (!list) return;
        // Bottom-up teardown: a list deletes only once it is empty and no
        // live post editorialises it — nothing cascades through it.
        const blockers = emptyBlockers();
        const members = (await this.db.listBlocks.where("listId").equals(listId).toArray()).filter(
          (b) => !b.deleted && b.kind === "place",
        );
        for (const block of members) blockers.members.push(block.refId);
        for (const post of await this.listPostsForList(listId)) {
          blockers.posts.push({ postId: post.id, title: post.title });
        }
        if (hasBlockers(blockers)) {
          throw new TeardownRefusedError(
            "deleting this list is blocked — remove its places and delete its posts first",
            blockers,
          );
        }
        await this.db.lists.put({ ...list, deleted: true, updatedAt: now });
        // The public list page comes down with the list — durably, not orphaned.
        await this.revokePublicationsFor({ kind: "list", id: listId }, now);
      },
    );
  }

  private async liveBlocks(listId: string): Promise<ListBlockRow[]> {
    const rows = (await this.db.listBlocks.where("listId").equals(listId).toArray()).filter(
      (b) => !b.deleted,
    );
    return rows.sort(compareByRank);
  }

  async getListBlocks(listId: string): Promise<ListBlockView[]> {
    const blocks = await this.liveBlocks(listId);
    const views: ListBlockView[] = [];
    for (const row of blocks) {
      if (row.kind !== "place" || row.content.type !== "place") continue;
      const place = live(await this.db.places.get(row.content.placeId));
      if (!place) continue;
      views.push({ block: { ...row, content: { type: "place", placeId: place.id } }, place });
    }
    return views;
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
    // aggregate transactions (spec/src/storage-sync.md).
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
          // Idempotent re-import (spec/src/interop.md): external-ref id first,
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
          // and the deep link back — spec/src/interop.md).
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

  /**
   * Blockers for removing one membership block: a live post about this list
   * embedding the place; and — when this is the place's last membership —
   * the place's live notes.
   */
  private async blockRemovalBlockers(block: ListBlockRow): Promise<TeardownBlockers> {
    const blockers = emptyBlockers();
    if (block.kind !== "place") return blockers;
    const placeId = block.refId;
    for (const embed of await this.liveEmbedsOfPlace(placeId)) {
      if (embed.post.listId === block.listId) {
        blockers.embeds.push({
          placeId,
          postId: embed.post.id,
          postTitle: embed.post.title,
          blockId: embed.block.id,
        });
      }
    }
    const remaining = (await this.livePlaceBlocks(placeId)).filter((b) => b.id !== block.id);
    if (remaining.length === 0) {
      for (const note of await this.liveNotesOfPlace(placeId)) {
        blockers.notes.push({
          placeId,
          noteId: note.id,
          ...(note.title !== undefined ? { title: note.title } : {}),
        });
      }
    }
    return blockers;
  }

  async removeBlock(blockId: string, now: string): Promise<void> {
    // The removal and its publication dirtying are one commit.
    await this.db.transaction(
      "rw",
      [
        this.db.listBlocks,
        this.db.notes,
        this.db.places,
        this.db.tagAssignments,
        this.db.lists,
        this.db.posts,
        this.db.postBlocks,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const block = live(await this.db.listBlocks.get(blockId));
        if (!block) return;
        const blockers = await this.blockRemovalBlockers(block);
        if (hasBlockers(blockers)) {
          throw new TeardownRefusedError(
            "removing this place is blocked — remove its post embeds (and notes, when this is its last list) first",
            blockers,
          );
        }
        await this.db.listBlocks.put({ ...block, deleted: true, updatedAt: now });
        // Membership is existence: dropping the last membership removes the place.
        if (block.kind === "place") {
          const remaining = await this.livePlaceBlocks(block.refId);
          if (remaining.length === 0) {
            const place = live(await this.db.places.get(block.refId));
            if (place) await this.tombstonePlace(place, now);
          }
        }
        await this.dirtyListPublications(block.listId, now);
      },
    );
  }

  async removeAllPlaces(listId: string, now: string): Promise<void> {
    // Edit mode's bulk removal: all-or-nothing with an actionable blocker
    // report (spec/src/posts.md — places with notes, places embedded in posts).
    await this.db.transaction(
      "rw",
      [
        this.db.listBlocks,
        this.db.notes,
        this.db.places,
        this.db.tagAssignments,
        this.db.lists,
        this.db.posts,
        this.db.postBlocks,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        if (!live(await this.db.lists.get(listId))) throw new Error("list not found");
        const blocks = (await this.liveBlocks(listId)).filter((b) => b.kind === "place");
        if (blocks.length === 0) return;
        const blockers = emptyBlockers();
        for (const block of blocks) {
          const each = await this.blockRemovalBlockers(block);
          blockers.embeds.push(...each.embeds);
          blockers.notes.push(...each.notes);
        }
        if (hasBlockers(blockers)) {
          throw new TeardownRefusedError(
            "emptying this list is blocked — some places carry notes or post embeds",
            blockers,
          );
        }
        for (const block of blocks) {
          await this.db.listBlocks.put({ ...block, deleted: true, updatedAt: now });
          const remaining = await this.livePlaceBlocks(block.refId);
          if (remaining.length === 0) {
            const place = live(await this.db.places.get(block.refId));
            if (place) await this.tombstonePlace(place, now);
          }
        }
        await this.dirtyListPublications(listId, now);
      },
    );
  }

  // ---------- posts ----------

  async listPosts(): Promise<Post[]> {
    return (await this.db.posts.toArray()).filter((p) => !p.deleted);
  }

  async listPostsForList(listId: string): Promise<Post[]> {
    return (await this.db.posts.where("listId").equals(listId).toArray()).filter((p) => !p.deleted);
  }

  async getPost(id: string): Promise<Post | undefined> {
    return live(await this.db.posts.get(id));
  }

  async createPost(post: Post): Promise<void> {
    await this.db.transaction("rw", [this.db.posts, this.db.lists], async () => {
      // A post editorialises exactly one live list.
      if (!live(await this.db.lists.get(post.listId))) {
        throw new Error("list not found — a post editorialises a live list");
      }
      await this.db.posts.put(post);
    });
  }

  async updatePost(post: Post): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.posts, this.db.publications, this.db.publicationOutbox],
      async () => {
        const existing = live(await this.db.posts.get(post.id));
        if (!existing) throw new Error("post not found — updatePost is not a creation path");
        // The list binding is the post's identity; retargeting a post to a
        // different list would silently break its embeds' member invariant.
        if (existing.listId !== post.listId) {
          throw new Error("a post's list binding is immutable");
        }
        await this.db.posts.put(post);
        await this.dirtyPostPublications(post.id, post.updatedAt);
      },
    );
  }

  async deletePost(postId: string, now: string): Promise<void> {
    // Deleting a post is itself the explicit act: its blocks, its own section
    // notes, attachments, and selections go with it; the list, its places, and
    // place notes are untouched (spec/src/posts.md §Bottom-up teardown).
    await this.db.transaction(
      "rw",
      [
        this.db.posts,
        this.db.postBlocks,
        this.db.notes,
        this.db.blockNoteAttachments,
        this.db.blockTagSelections,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const post = live(await this.db.posts.get(postId));
        if (!post) return;
        await this.db.posts.put({ ...post, deleted: true, updatedAt: now });
        await this.revokePublicationsFor({ kind: "post", id: postId }, now);
        const blocks = (await this.db.postBlocks.where("postId").equals(postId).toArray()).filter(
          (b) => !b.deleted,
        );
        for (const block of blocks) {
          await this.tombstonePostBlockEdges(block, now);
          await this.db.postBlocks.put({ ...block, deleted: true, updatedAt: now });
        }
        // The post's own section notes die with it — they are its prose.
        const sectionNotes = (
          await this.db.notes.where("targetKey").equals(`post:${postId}`).toArray()
        ).filter((n) => !n.deleted);
        for (const note of sectionNotes) {
          await this.tombstoneNote(note, now);
        }
      },
    );
  }

  private async tombstonePostBlockEdges(block: PostBlockRow, now: string): Promise<void> {
    const attachments = (
      await this.db.blockNoteAttachments.where("blockId").equals(block.id).toArray()
    ).filter((a) => !a.deleted);
    for (const a of attachments) {
      await this.db.blockNoteAttachments.put({ ...a, deleted: true, updatedAt: now });
    }
    const selections = (
      await this.db.blockTagSelections.where("blockId").equals(block.id).toArray()
    ).filter((s) => !s.deleted);
    for (const s of selections) {
      await this.db.blockTagSelections.put({ ...s, deleted: true, updatedAt: now });
    }
  }

  private async livePostBlocks(postId: string): Promise<PostBlockRow[]> {
    const rows = (await this.db.postBlocks.where("postId").equals(postId).toArray()).filter(
      (b) => !b.deleted,
    );
    return rows.sort(compareByRank);
  }

  async getPostBlocks(postId: string): Promise<PostBlockView[]> {
    const blocks = await this.livePostBlocks(postId);
    return Promise.all(
      blocks.map(async (block): Promise<PostBlockView> => {
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
        const selectionRows = (
          await this.db.blockTagSelections.where("blockId").equals(block.id).toArray()
        ).filter((s) => !s.deleted);
        const tagSelections = (
          await Promise.all(
            selectionRows.map(
              async (
                selection,
              ): Promise<{ selection: BlockTagSelection; tag: Tag } | undefined> => {
                const tag = live(await this.db.tags.get(selection.tagId));
                return tag ? { selection, tag } : undefined;
              },
            ),
          )
        ).filter((x): x is { selection: BlockTagSelection; tag: Tag } => x !== undefined);
        return { block, ...(place ? { place } : {}), attachments, tagSelections };
      }),
    );
  }

  async addPostSection(
    postId: string,
    body: string,
    now: string,
    title?: string,
  ): Promise<PostBlock> {
    return this.db.transaction(
      "rw",
      [
        this.db.posts,
        this.db.postBlocks,
        this.db.notes,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        if (!live(await this.db.posts.get(postId))) throw new Error("post not found");
        const note: Note = {
          id: newId(),
          target: { kind: "post", postId },
          ...(title ? { title } : {}),
          body,
          mediaIds: [],
          shareable: false,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.notes.put(toNoteRow(note));
        const blocks = await this.livePostBlocks(postId);
        const lastRank = blocks.length > 0 ? (blocks[blocks.length - 1]?.rank ?? null) : null;
        const block: PostBlock = {
          id: newId(),
          postId,
          rank: rankAfter(lastRank),
          content: { type: "section", noteId: note.id },
          createdAt: now,
          updatedAt: now,
        };
        await this.db.postBlocks.put(toPostBlockRow(block));
        await this.dirtyPostPublications(postId, now);
        return block;
      },
    );
  }

  async embedPlaceInPost(postId: string, placeId: PlaceId, now: string): Promise<PostBlock> {
    return this.db.transaction(
      "rw",
      [
        this.db.posts,
        this.db.postBlocks,
        this.db.places,
        this.db.lists,
        this.db.listBlocks,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const post = live(await this.db.posts.get(postId));
        if (!post) throw new Error("post not found");
        // A post embeds members of its list (spec/src/posts.md §Where embeds
        // come from) — the editor adds a non-member to the list first.
        const membership = await this.livePlaceBlocks(placeId);
        if (!membership.some((b) => b.listId === post.listId)) {
          throw new Error("place is not a member of this post's list — add it to the list first");
        }
        const blocks = await this.livePostBlocks(postId);
        if (blocks.some((b) => b.kind === "place" && b.refId === placeId)) {
          throw new Error("place already embedded in this post");
        }
        const lastRank = blocks.length > 0 ? (blocks[blocks.length - 1]?.rank ?? null) : null;
        const block: PostBlock = {
          id: newId(),
          postId,
          rank: rankAfter(lastRank),
          content: { type: "place", placeId },
          createdAt: now,
          updatedAt: now,
        };
        await this.db.postBlocks.put(toPostBlockRow(block));
        await this.dirtyPostPublications(postId, now);
        return block;
      },
    );
  }

  async movePostBlock(blockId: string, beforeBlockId: string | null, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.postBlocks, this.db.posts, this.db.publications, this.db.publicationOutbox],
      async () => {
        const block = live(await this.db.postBlocks.get(blockId));
        if (!block) throw new Error("block not found");
        const siblings = (await this.livePostBlocks(block.postId)).filter((b) => b.id !== blockId);
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
        await this.db.postBlocks.put({ ...block, rank, updatedAt: now });
        await this.dirtyPostPublications(block.postId, now);
      },
    );
  }

  async removePostBlock(blockId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.postBlocks,
        this.db.posts,
        this.db.notes,
        this.db.blockNoteAttachments,
        this.db.blockTagSelections,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const block = live(await this.db.postBlocks.get(blockId));
        if (!block) return;
        await this.tombstonePostBlockEdges(block, now);
        await this.db.postBlocks.put({ ...block, deleted: true, updatedAt: now });
        // A removed section block takes its post-owned note with it — through
        // the full note tombstone (its standalone page revokes, its edges
        // tombstone); a removed embed frees the place (its notes and
        // membership are untouched).
        if (block.content.type === "section") {
          const note = live(await this.db.notes.get(block.content.noteId));
          if (note) await this.tombstoneNote(note, now);
        }
        await this.dirtyPostPublications(block.postId, now);
      },
    );
  }

  async attachNoteToPostBlock(
    blockId: string,
    noteId: string,
    now: string,
  ): Promise<BlockNoteAttachment> {
    return this.db.transaction(
      "rw",
      [
        this.db.postBlocks,
        this.db.posts,
        this.db.notes,
        this.db.blockNoteAttachments,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const block = live(await this.db.postBlocks.get(blockId));
        if (block?.content.type !== "place") {
          throw new Error("attachments require a post place block");
        }
        const note = live(await this.db.notes.get(noteId));
        if (!note) throw new Error("note not found");
        // Attaching puts the note into the post — only shareable notes may
        // enter a shareable surface (spec/src/notes.md §Share eligibility).
        if (!note.shareable) {
          throw new Error("only shareable notes can be attached to a post block");
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
        await this.dirtyPostPublications(block.postId, now);
        return attachment;
      },
    );
  }

  async detachNoteFromPostBlock(blockId: string, noteId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.postBlocks,
        this.db.blockNoteAttachments,
        this.db.publications,
        this.db.publicationOutbox,
        this.db.posts,
      ],
      async () => {
        const pair = await this.db.blockNoteAttachments
          .where("[blockId+noteId]")
          .equals([blockId, noteId])
          .toArray();
        const existing = pair.find((a) => !a.deleted);
        if (!existing) return;
        await this.db.blockNoteAttachments.put({ ...existing, deleted: true, updatedAt: now });
        const block = await this.db.postBlocks.get(blockId);
        if (block && !block.deleted) {
          await this.dirtyPostPublications(block.postId, now);
        }
      },
    );
  }

  async selectTagForPostBlock(
    blockId: string,
    tagId: string,
    now: string,
  ): Promise<BlockTagSelection> {
    return this.db.transaction(
      "rw",
      [
        this.db.postBlocks,
        this.db.posts,
        this.db.tags,
        this.db.tagAssignments,
        this.db.blockTagSelections,
        this.db.publications,
        this.db.publicationOutbox,
      ],
      async () => {
        const block = live(await this.db.postBlocks.get(blockId));
        if (block?.content.type !== "place") {
          throw new Error("tag selections require a post place block");
        }
        if (!live(await this.db.tags.get(tagId))) throw new Error("tag not found");
        // The invariant: a selected tag is actually assigned to the block's place.
        const pairAssignment = await this.db.tagAssignments
          .where("[placeId+tagId]")
          .equals([block.content.placeId, tagId])
          .toArray();
        if (!pairAssignment.find((a) => !a.deleted)) {
          throw new Error("tag is not assigned to this block's place");
        }
        const pair = await this.db.blockTagSelections
          .where("[blockId+tagId]")
          .equals([blockId, tagId])
          .toArray();
        const existing = pair.find((s) => !s.deleted);
        if (existing) return existing;
        const selection: BlockTagSelection = {
          id: newId(),
          blockId,
          tagId,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.blockTagSelections.put(selection);
        await this.dirtyPostPublications(block.postId, now);
        return selection;
      },
    );
  }

  async deselectTagForPostBlock(blockId: string, tagId: string, now: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [
        this.db.postBlocks,
        this.db.blockTagSelections,
        this.db.publications,
        this.db.publicationOutbox,
        this.db.posts,
      ],
      async () => {
        const pair = await this.db.blockTagSelections
          .where("[blockId+tagId]")
          .equals([blockId, tagId])
          .toArray();
        const existing = pair.find((s) => !s.deleted);
        if (!existing) return;
        await this.db.blockTagSelections.put({ ...existing, deleted: true, updatedAt: now });
        const block = await this.db.postBlocks.get(blockId);
        if (block && !block.deleted) {
          await this.dirtyPostPublications(block.postId, now);
        }
      },
    );
  }
}
