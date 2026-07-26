/**
 * Everything the restore path refuses before it writes (spec/src/storage-sync.md
 * §Backup and restore). Schema-shaped rows are not enough, so these gates check
 * coordinates, identity immutability, and the graph the archive would leave
 * behind — in replace mode over the archive alone, and in merge mode over the
 * last-write-wins result of archive + local library.
 */
import { markerKey, type Place } from "@placemarks/domain";
import type { DexieRepository } from "../../data/repo";
import type { BackupData } from "./schema";

interface CoordinateFacts {
  lat?: unknown;
  lng?: unknown;
}

function coordinatesInRange(facts: CoordinateFacts): boolean {
  const { lat, lng } = facts;
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

interface RefLike {
  type?: unknown;
  id?: unknown;
}

const validRef = (ref: RefLike | undefined): boolean =>
  ref === undefined ||
  ((ref.type === "node" || ref.type === "way" || ref.type === "relation") &&
    typeof ref.id === "string" &&
    /^\d+$/.test(ref.id));

/**
 * Graph invariants before any write (spec/src/storage-sync.md): every live
 * place has a live list membership (replace mode — merge may complete
 * membership from existing data), OSM references are well-formed, and live
 * media metadata has matching bytes in the archive.
 */
export function validateGraph(
  data: BackupData,
  entries: Record<string, Uint8Array>,
  mode: "replace" | "merge",
): void {
  // One non-empty id per row — bulk restore must never let a duplicate or an
  // unaddressable row silently win.
  for (const [table, rowsOf] of Object.entries(data)) {
    const seen = new Set<string>();
    for (const row of rowsOf as { id: string }[]) {
      if (row.id.trim() === "") {
        throw new Error(`${table} contains a row with an empty id — refusing to import`);
      }
      if (seen.has(row.id)) {
        throw new Error(`duplicate ${table} id ${row.id} — refusing to import`);
      }
      seen.add(row.id);
    }
  }

  for (const place of data.places) {
    const row = place as {
      id: string;
      deleted?: boolean;
      currentOsmRef?: RefLike;
      osmRefHistory?: { ref?: RefLike }[];
      firstSeen?: { ref?: RefLike; source?: unknown; license?: unknown; attribution?: unknown };
      lastVerified?: { ref?: RefLike; source?: unknown; license?: unknown; attribution?: unknown };
    };
    const refs: (RefLike | undefined)[] = [
      row.currentOsmRef,
      row.firstSeen?.ref,
      row.lastVerified?.ref,
      ...(row.osmRefHistory ?? []).map((entry) => entry.ref),
    ];
    for (const ref of refs) {
      if (!validRef(ref)) {
        throw new Error(`place ${row.id} carries a malformed OSM reference — refusing to import`);
      }
    }
    // History entries are completed (or current) intervals: every entry
    // states when its link began. An "unlinked" moment with no beginning is
    // not a valid interval shape.
    for (const entry of (row.osmRefHistory ?? []) as { linkedAt?: unknown }[]) {
      if (typeof entry.linkedAt !== "string" || entry.linkedAt === "") {
        throw new Error(
          `place ${row.id} carries a history interval with no linkedAt — refusing to import`,
        );
      }
    }
    if (row.deleted) continue;
    const origin = (place as { origin?: string }).origin;
    const resolutionState = (place as { resolutionState?: string }).resolutionState;
    // Linkage only ever gains OSM identity: an OSM-origin place always keeps
    // a current binding — evidence without one is a malformed identity.
    if (origin === "osm" && !row.currentOsmRef) {
      throw new Error(
        `place ${row.id} claims OSM origin but has no current binding — refusing to import`,
      );
    }
    if (origin === "osm" && resolutionState === "unlinked") {
      throw new Error(`place ${row.id} claims OSM origin but is unlinked — refusing to import`);
    }
    if (row.currentOsmRef && resolutionState === "unlinked") {
      throw new Error(
        `place ${row.id} has a current OSM binding but claims to be unlinked — refusing to import`,
      );
    }
    if (
      row.currentOsmRef &&
      typeof (place as { currentOsmLinkedAt?: unknown }).currentOsmLinkedAt !== "string"
    ) {
      throw new Error(
        `place ${row.id} has a current OSM binding with no linked-at timestamp — refusing to import`,
      );
    }
    // A linked place without its copied evidence cannot render offline or
    // recover a moved element — the shape is invalid, not merely incomplete.
    if (row.currentOsmRef && (!row.firstSeen || !row.lastVerified)) {
      throw new Error(
        `place ${row.id} is OSM-linked but carries no copied evidence — refusing to import`,
      );
    }
    // An OSM-origin place always has copied evidence from its creation; a row
    // claiming the origin without any binding or evidence is malformed.
    if (origin === "osm" && (!row.firstSeen || !row.lastVerified)) {
      throw new Error(
        `place ${row.id} claims OSM origin without binding or copied evidence — refusing to import`,
      );
    }
    // Manual/import pins need their owner/imported fallback for as long as
    // they are unlinked.  Without it the app has neither renderable facts nor
    // a resolver identity, even though the row superficially validates.
    const manual = (place as { manual?: CoordinateFacts & { name?: unknown } }).manual;
    if (!row.currentOsmRef && origin !== "osm") {
      if (
        !manual ||
        typeof manual.name !== "string" ||
        manual.name.trim() === "" ||
        !coordinatesInRange(manual)
      ) {
        throw new Error(
          `place ${row.id} is unlinked but carries no valid manual facts — refusing to import`,
        );
      }
      if (resolutionState !== "unlinked") {
        throw new Error(
          `place ${row.id} has no current binding but claims ${resolutionState ?? "no"} resolution state — refusing to import`,
        );
      }
    }
    // Copied evidence always states its true provenance; anything else is a
    // false source/licence/attribution claim.
    for (const evidence of [row.firstSeen, row.lastVerified]) {
      if (!evidence) continue;
      if (
        evidence.source !== "OpenStreetMap" ||
        evidence.license !== "ODbL-1.0" ||
        evidence.attribution !== "© OpenStreetMap contributors"
      ) {
        throw new Error(
          `place ${row.id} carries evidence with a false source/license/attribution claim — refusing to import`,
        );
      }
    }
  }

  if (mode === "replace") {
    const liveLists = new Set(
      data.lists.filter((l) => !(l as { deleted?: boolean }).deleted).map((l) => l.id),
    );
    const livePlaces = new Set(
      data.places.filter((p) => !(p as { deleted?: boolean }).deleted).map((p) => p.id),
    );
    const withMembership = new Set<string>();
    for (const block of data.listBlocks) {
      const row = block as unknown as {
        id: string;
        deleted?: boolean;
        listId: string;
        content?: { type?: string; placeId?: string };
      };
      if (row.deleted || row.content?.type !== "place" || !liveLists.has(row.listId)) continue;
      const placeId = row.content.placeId ?? "";
      if (!livePlaces.has(placeId)) {
        throw new Error(`list block ${row.id} targets no live place — the backup graph is broken`);
      }
      withMembership.add(placeId);
    }
    for (const place of data.places) {
      const row = place as { id: string; deleted?: boolean };
      if (!row.deleted && !withMembership.has(row.id)) {
        throw new Error(
          `place ${row.id} has no live list membership — membership is existence; ` +
            "a backup with orphan places violates the graph and is refused",
        );
      }
    }

    // Full-edge audit: every live edge must join live rows consistently.
    const liveTags = new Set(
      data.tags.filter((t) => !(t as { deleted?: boolean }).deleted).map((t) => t.id),
    );
    const liveTagNames = new Set<string>();
    for (const tag of data.tags as { id: string; deleted?: boolean; nameNorm: string }[]) {
      if (tag.deleted) continue;
      if (tag.nameNorm === "") {
        throw new Error(`tag ${tag.id} has an empty normalized name — graph refused`);
      }
      if (liveTagNames.has(tag.nameNorm)) {
        throw new Error(`two live tags normalize to ${tag.nameNorm} — tags are unique; refused`);
      }
      liveTagNames.add(tag.nameNorm);
    }
    const assignmentPairs = new Set<string>();
    for (const assignment of data.tagAssignments) {
      const row = assignment as { id: string; deleted?: boolean; tagId: string; placeId: string };
      if (row.deleted) continue;
      if (!liveTags.has(row.tagId)) {
        throw new Error(`tag assignment ${row.id} references a missing tag — graph refused`);
      }
      if (!livePlaces.has(row.placeId)) {
        throw new Error(`tag assignment ${row.id} references a missing place — graph refused`);
      }
      const pair = `${row.placeId}::${row.tagId}`;
      if (assignmentPairs.has(pair)) {
        throw new Error(
          `duplicate live tag assignment for place ${row.placeId} — a tag applies at most once`,
        );
      }
      assignmentPairs.add(pair);
    }
    // Live markers are unique (colour, icon) pairs (spec/src/data-model.md).
    const markerKeys = new Set<string>();
    for (const list of data.lists) {
      const row = list as {
        id: string;
        deleted?: boolean;
        marker?: { color?: unknown; icon?: unknown };
      };
      if (row.deleted) continue;
      if (typeof row.marker?.color !== "string" || typeof row.marker.icon !== "string") {
        throw new Error(`list ${row.id} carries no marker — refusing to import`);
      }
      const key = markerKey({ color: row.marker.color, icon: row.marker.icon });
      if (markerKeys.has(key)) {
        throw new Error(`two live lists share the marker ${key} — markers are unique; refused`);
      }
      markerKeys.add(key);
    }
    // Posts editorialise live lists; their block sequence joins live rows.
    const livePosts = new Map<string, string>(); // postId → listId
    for (const post of data.posts) {
      const row = post as unknown as { id: string; deleted?: boolean; listId: string };
      if (row.deleted) continue;
      if (!liveLists.has(row.listId)) {
        throw new Error(`post ${row.id} editorialises no live list — graph refused`);
      }
      livePosts.set(row.id, row.listId);
    }
    // Every live note must target a live row — attached or not.
    for (const note of data.notes) {
      const row = note as {
        id: string;
        deleted?: boolean;
        target?: { kind?: string; postId?: string; placeId?: string };
      };
      if (row.deleted) continue;
      const targetLive =
        row.target?.kind === "post"
          ? livePosts.has(row.target.postId ?? "")
          : row.target?.kind === "place"
            ? livePlaces.has(row.target.placeId ?? "")
            : false;
      if (!targetLive) {
        throw new Error(`note ${row.id} targets no live row — graph refused`);
      }
    }
    const notesById = new Map(
      data.notes.map((n) => [
        n.id,
        n as {
          deleted?: boolean;
          target?: { kind?: string; postId?: string; placeId?: string };
        },
      ]),
    );
    const blockPairs = new Set<string>();
    const membershipByList = new Map<string, Set<string>>();
    for (const block of data.listBlocks) {
      const row = block as unknown as {
        id: string;
        deleted?: boolean;
        listId: string;
        content?: { type?: string; placeId?: string };
      };
      if (row.deleted) continue;
      if (!liveLists.has(row.listId)) {
        throw new Error(`list block ${row.id} belongs to no live list — graph refused`);
      }
      // Lists carry membership only (2026-07-19): a live section block on a
      // list is pre-pivot residue the pivot should have moved.
      if (row.content?.type !== "place" || !row.content.placeId) {
        throw new Error(`list block ${row.id} is not a place membership — graph refused`);
      }
      const pair = `${row.listId}::${row.content.placeId}`;
      if (blockPairs.has(pair)) {
        throw new Error(
          `place appears twice in one list (${row.listId}) — a place may appear at most once per list`,
        );
      }
      blockPairs.add(pair);
      const members = membershipByList.get(row.listId) ?? new Set<string>();
      members.add(row.content.placeId);
      membershipByList.set(row.listId, members);
    }
    // Post blocks: sections join their own post's notes; embeds reference live
    // members of the post's list, at most once per post.
    const embedPairs = new Set<string>();
    const postBlocksById = new Map<
      string,
      { postId: string; content?: { type?: string; placeId?: string; noteId?: string } }
    >();
    for (const block of data.postBlocks) {
      const row = block as unknown as {
        id: string;
        deleted?: boolean;
        postId: string;
        content?: { type?: string; placeId?: string; noteId?: string };
      };
      if (row.deleted) continue;
      const listId = livePosts.get(row.postId);
      if (!listId) {
        throw new Error(`post block ${row.id} belongs to no live post — graph refused`);
      }
      postBlocksById.set(row.id, row);
      if (row.content?.type === "section" && row.content.noteId) {
        const note = notesById.get(row.content.noteId);
        if (
          !note ||
          note.deleted ||
          note.target?.kind !== "post" ||
          note.target.postId !== row.postId
        ) {
          throw new Error(
            `section block ${row.id} and its note disagree about the owning post — graph refused`,
          );
        }
      } else if (row.content?.type === "place" && row.content.placeId) {
        if (!livePlaces.has(row.content.placeId)) {
          throw new Error(`post block ${row.id} embeds no live place — graph refused`);
        }
        if (!membershipByList.get(listId)?.has(row.content.placeId)) {
          throw new Error(
            `post block ${row.id} embeds a place that is not a member of the post's list — graph refused`,
          );
        }
        const pair = `${row.postId}::${row.content.placeId}`;
        if (embedPairs.has(pair)) {
          throw new Error(
            `place embedded twice in one post (${row.postId}) — at most once per post; refused`,
          );
        }
        embedPairs.add(pair);
      } else {
        throw new Error(`post block ${row.id} has no valid content — graph refused`);
      }
    }
    const attachmentPairs = new Set<string>();
    for (const attachment of data.blockNoteAttachments) {
      const row = attachment as { id: string; deleted?: boolean; blockId: string; noteId: string };
      if (row.deleted) continue;
      const pair = `${row.blockId}::${row.noteId}`;
      if (attachmentPairs.has(pair)) {
        throw new Error(`duplicate live attachment for block ${row.blockId} — graph refused`);
      }
      attachmentPairs.add(pair);
      const block = postBlocksById.get(row.blockId);
      const note = notesById.get(row.noteId);
      if (
        block?.content?.type !== "place" ||
        !note ||
        note.deleted ||
        note.target?.kind !== "place" ||
        note.target.placeId !== block.content.placeId
      ) {
        throw new Error(
          `attachment ${row.id} joins a note to a block about a different place — graph refused`,
        );
      }
      // Attachment implies publication membership: only shareable notes qualify.
      if ((note as { shareable?: boolean }).shareable !== true) {
        throw new Error(
          `attachment ${row.id} joins a private (non-shareable) note to a post — graph refused`,
        );
      }
    }
  }

  for (const asset of data.mediaAssets) {
    const row = asset as { id: string; deleted?: boolean; localBlobKey: string };
    if (!row.deleted && !entries[`media/${row.localBlobKey}`]) {
      throw new Error(
        `media asset ${row.id} declares bytes (media/${row.localBlobKey}) the archive does not contain`,
      );
    }
  }
}

/**
 * Merge safety: an incoming row reusing an existing PlaceId must actually be
 * the same place — disjoint OSM identities under one id are a collision, not
 * an update (spec/src/place-identity.md).
 */
/** Canonical identity keys — derived from the domain fields, never from a (forgeable) refKeys index. */
export function canonicalKeys(row: {
  currentOsmRef?: { type: string; id: string };
  osmRefHistory?: { ref: { type: string; id: string } }[];
}): string[] {
  return [
    ...(row.currentOsmRef ? [`${row.currentOsmRef.type}/${row.currentOsmRef.id}`] : []),
    ...(row.osmRefHistory ?? []).map((entry) => `${entry.ref.type}/${entry.ref.id}`),
  ];
}

const historyIdentity = (entry: Place["osmRefHistory"][number]): string =>
  `${entry.ref.type}/${entry.ref.id}@${entry.linkedAt}`;

const externalIdentity = (entry: NonNullable<Place["externalRefs"]>[number]): string =>
  entry.fid ? `${entry.provider}:fid:${entry.fid}` : `${entry.provider}:url:${entry.url}`;

/**
 * Place metadata is not ordinary LWW data. `origin`, `createdAt`, and
 * `firstSeen` are immutable; link history and external provenance only grow.
 * Mutable resolver/manual state still follows the winning row.
 */
export function mergePlaceVersions(
  base: Place,
  donor: Place,
  donorWins: boolean,
  preserveBaseFirstSeen = true,
): Place {
  let winner = donorWins ? donor : base;
  const history = new Map(base.osmRefHistory.map((entry) => [historyIdentity(entry), entry]));
  for (const entry of donor.osmRefHistory) {
    const key = historyIdentity(entry);
    const current = history.get(key);
    // A completed interval contains strictly more immutable history than the
    // same open interval, so retain its end/reason when one side has it.
    if (!current || (!current.unlinkedAt && entry.unlinkedAt)) history.set(key, entry);
  }
  const externalRefs = new Map(
    (base.externalRefs ?? []).map((entry) => [externalIdentity(entry), entry]),
  );
  for (const entry of donor.externalRefs ?? []) {
    if (!externalRefs.has(externalIdentity(entry))) {
      externalRefs.set(externalIdentity(entry), entry);
    }
  }
  const latestEvidence =
    !base.lastVerified ||
    (donor.lastVerified && donor.lastVerified.observedAt > base.lastVerified.observedAt)
      ? donor.lastVerified
      : base.lastVerified;
  const earliestEvidence = preserveBaseFirstSeen
    ? (base.firstSeen ?? donor.firstSeen)
    : !base.firstSeen || (donor.firstSeen && donor.firstSeen.observedAt < base.firstSeen.observedAt)
      ? donor.firstSeen
      : base.firstSeen;
  const refKeyOf = (ref: Place["currentOsmRef"]): string | undefined =>
    ref ? `${ref.type}/${ref.id}` : undefined;
  const baseCurrent = refKeyOf(base.currentOsmRef);
  const donorCurrent = refKeyOf(donor.currentOsmRef);
  let conflictingRelink = false;
  if (baseCurrent && donorCurrent && baseCurrent !== donorCurrent) {
    const donorObservedBase = donor.osmRefHistory.some(
      (entry) => refKeyOf(entry.ref) === baseCurrent,
    );
    const baseObservedDonor = base.osmRefHistory.some(
      (entry) => refKeyOf(entry.ref) === donorCurrent,
    );
    if (donorObservedBase && !baseObservedDonor) winner = donor;
    else if (baseObservedDonor && !donorObservedBase) winner = base;
    else conflictingRelink = true;
  }
  return {
    ...winner,
    id: base.id,
    origin: base.origin,
    createdAt: base.createdAt,
    firstSeen: earliestEvidence,
    ...(latestEvidence ? { lastVerified: latestEvidence } : {}),
    osmRefHistory: [...history.values()],
    ...(externalRefs.size > 0 ? { externalRefs: [...externalRefs.values()] } : {}),
    ...(conflictingRelink ? { resolutionState: "needs-review" } : {}),
  };
}

export async function validateMergeIdentities(
  repo: DexieRepository,
  data: BackupData,
): Promise<void> {
  const keysOf = canonicalKeys;
  for (const place of data.places) {
    const row = place as unknown as {
      id: string;
      deleted?: boolean;
      refKeys?: string[];
      currentOsmRef?: { type: string; id: string };
      osmRefHistory?: { ref: { type: string; id: string } }[];
    };
    const existing = await repo.db.places.get(row.id);
    if (!existing) continue;
    const incomingPlace = row as unknown as Place;
    if (existing.origin !== incomingPlace.origin) {
      throw new Error(`incoming PlaceId ${row.id} changes immutable origin — refusing to merge`);
    }
    if (existing.createdAt !== incomingPlace.createdAt) {
      throw new Error(
        `incoming PlaceId ${row.id} changes immutable creation identity — refusing to merge`,
      );
    }
    if (row.deleted) continue;
    const incomingKeys = new Set(keysOf(row));
    const existingKeys = new Set(keysOf(existing as typeof row & { refKeys?: string[] }));
    // A manual pin reusing an OSM place's UUID is a different place — an id
    // collision, not an update (links only ever gain OSM identity).
    if (existingKeys.size > 0 && incomingKeys.size === 0) {
      throw new Error(
        `incoming PlaceId ${row.id} collides with a different OSM identity — refusing to merge`,
      );
    }
    if (!existing.currentOsmRef || !row.currentOsmRef) continue;
    const overlap = [...incomingKeys].some((key) => existingKeys.has(key));
    if (!overlap) {
      throw new Error(
        `incoming PlaceId ${row.id} collides with a different OSM identity — refusing to merge`,
      );
    }
  }
}

/**
 * Merge final-state audit: the graph AFTER merging must not contain a live
 * orphan place — membership is existence, merged or not.
 */
export async function validateMergeFinalGraph(
  repo: DexieRepository,
  data: BackupData,
): Promise<void> {
  // Every table resolves per id with the same last-write-wins rule the merge
  // itself applies — an older incoming tombstone must not falsely kill a
  // newer live row, and a newer tombstone must count as a deletion.
  type Aged = { id: string; deleted?: boolean; updatedAt: string };
  const lww = <T extends Aged>(existing: T[], incoming: T[]): Map<string, T> => {
    const byId = new Map<string, T>();
    for (const row of existing) byId.set(row.id, row);
    for (const row of incoming) {
      const current = byId.get(row.id);
      if (!current || row.updatedAt > current.updatedAt) byId.set(row.id, row);
    }
    return byId;
  };

  const listById = lww(
    (await repo.db.lists.toArray()) as unknown as Aged[],
    data.lists as unknown as Aged[],
  );
  const liveLists = new Set<string>();
  for (const list of listById.values()) if (!list.deleted) liveLists.add(list.id);
  // Live markers stay unique (colour, icon) pairs in the merged final state.
  const finalMarkers = new Set<string>();
  for (const list of listById.values()) {
    if (list.deleted) continue;
    const marker = (list as { marker?: { color?: unknown; icon?: unknown } }).marker;
    if (typeof marker?.color !== "string" || typeof marker.icon !== "string") {
      throw new Error(`merging would leave list ${list.id} without a marker — refusing`);
    }
    const key = markerKey({ color: marker.color, icon: marker.icon });
    if (finalMarkers.has(key)) {
      throw new Error(`merging would leave two live lists sharing the marker ${key} — refusing`);
    }
    finalMarkers.add(key);
  }

  type BlockLike = Aged & { listId: string; content?: { type?: string; placeId?: string } };
  const blockById = lww(
    (await repo.db.listBlocks.toArray()) as unknown as BlockLike[],
    data.listBlocks as unknown as BlockLike[],
  );
  const membership = new Set<string>();
  for (const block of blockById.values()) {
    if (block.deleted || block.content?.type !== "place") continue;
    if (liveLists.has(block.listId) && block.content.placeId) {
      membership.add(block.content.placeId);
    }
  }

  const placeById = lww(
    (await repo.db.places.toArray()) as unknown as Aged[],
    data.places as unknown as Aged[],
  );
  const livePlaces = new Map<string, boolean>();
  for (const place of placeById.values()) livePlaces.set(place.id, !place.deleted);
  for (const [placeId, isLive] of livePlaces) {
    if (isLive && !membership.has(placeId)) {
      throw new Error(
        `merging would leave place ${placeId} without a live list membership — refusing`,
      );
    }
  }
  // The inverse edge must hold too: a live block never targets a dead place.
  for (const block of blockById.values()) {
    if (block.deleted || block.content?.type !== "place") continue;
    if (!liveLists.has(block.listId)) continue;
    const placeId = block.content.placeId ?? "";
    if (livePlaces.get(placeId) !== true) {
      throw new Error(`merging would leave block ${block.id} targeting a deleted place — refusing`);
    }
  }

  // Tag edges must also survive the merge: a live assignment needs a live tag
  // AND a live place in the final state.
  const tagById = lww(
    (await repo.db.tags.toArray()) as unknown as Aged[],
    data.tags as unknown as Aged[],
  );
  const liveTags = new Map<string, boolean>();
  const finalTagNames = new Set<string>();
  for (const tag of tagById.values()) {
    liveTags.set(tag.id, !tag.deleted);
    if (tag.deleted) continue;
    const nameNorm = (tag as { nameNorm?: string }).nameNorm ?? "";
    if (nameNorm === "" || finalTagNames.has(nameNorm)) {
      throw new Error(
        `merging would leave duplicate or empty normalized tag ${nameNorm} — refusing`,
      );
    }
    finalTagNames.add(nameNorm);
  }
  type AssignmentLike = Aged & { tagId: string; placeId: string };
  const assignments = lww(
    (await repo.db.tagAssignments.toArray()) as unknown as AssignmentLike[],
    data.tagAssignments as unknown as AssignmentLike[],
  );
  for (const edge of assignments.values()) {
    if (edge.deleted) continue;
    if (liveTags.get(edge.tagId) !== true) {
      throw new Error(
        `merging would leave tag assignment ${edge.id} without a live tag — refusing`,
      );
    }
    if (livePlaces.get(edge.placeId) !== true) {
      throw new Error(
        `merging would leave tag assignment ${edge.id} without a live place — refusing`,
      );
    }
  }

  // Posts editorialise live lists in the final state.
  type PostLike = Aged & { listId: string };
  const postById = lww(
    (await repo.db.posts.toArray()) as unknown as PostLike[],
    data.posts as unknown as PostLike[],
  );
  const livePostList = new Map<string, string>();
  for (const post of postById.values()) {
    if (post.deleted) continue;
    if (!liveLists.has(post.listId)) {
      throw new Error(`merging would leave post ${post.id} without a live list — refusing`);
    }
    livePostList.set(post.id, post.listId);
  }

  // Every live note must target a live row in the final state.
  type NoteLike = Aged & {
    shareable?: boolean;
    target?: { kind?: string; placeId?: string; postId?: string };
  };
  const noteById = lww(
    (await repo.db.notes.toArray()) as unknown as NoteLike[],
    data.notes as unknown as NoteLike[],
  );
  for (const note of noteById.values()) {
    if (note.deleted) continue;
    const targetLive =
      note.target?.kind === "place"
        ? livePlaces.get(note.target.placeId ?? "") === true
        : note.target?.kind === "post"
          ? livePostList.has(note.target.postId ?? "")
          : false;
    if (!targetLive) {
      throw new Error(`merging would leave note ${note.id} targeting no live row — refusing`);
    }
  }

  // Final membership per list — post embeds must reference members.
  const membershipByList = new Map<string, Set<string>>();
  for (const block of blockById.values()) {
    if (block.deleted || block.content?.type !== "place") continue;
    if (!liveLists.has(block.listId) || !block.content.placeId) continue;
    const members = membershipByList.get(block.listId) ?? new Set<string>();
    members.add(block.content.placeId);
    membershipByList.set(block.listId, members);
  }
  type PostBlockLike = Aged & {
    postId: string;
    content?: { type?: string; placeId?: string; noteId?: string };
  };
  const postBlockById = lww(
    (await repo.db.postBlocks.toArray()) as unknown as PostBlockLike[],
    data.postBlocks as unknown as PostBlockLike[],
  );
  for (const block of postBlockById.values()) {
    if (block.deleted) continue;
    const listId = livePostList.get(block.postId);
    if (!listId) {
      throw new Error(`merging would leave post block ${block.id} without a live post — refusing`);
    }
    if (block.content?.type === "place") {
      const placeId = block.content.placeId ?? "";
      if (livePlaces.get(placeId) !== true || !membershipByList.get(listId)?.has(placeId)) {
        throw new Error(
          `merging would leave post block ${block.id} embedding a non-member place — refusing`,
        );
      }
    } else if (block.content?.type === "section") {
      const note = noteById.get(block.content.noteId ?? "");
      if (
        !note ||
        note.deleted ||
        note.target?.kind !== "post" ||
        note.target.postId !== block.postId
      ) {
        throw new Error(
          `merging would leave section block ${block.id} disagreeing with its note — refusing`,
        );
      }
    }
  }

  type AttachmentLike = {
    id: string;
    deleted?: boolean;
    updatedAt: string;
    blockId: string;
    noteId: string;
  };
  const attachmentById = new Map<string, AttachmentLike>();
  for (const row of (await repo.db.blockNoteAttachments.toArray()) as unknown as AttachmentLike[]) {
    attachmentById.set(row.id, row);
  }
  for (const row of data.blockNoteAttachments as unknown as AttachmentLike[]) {
    const current = attachmentById.get(row.id);
    if (!current || row.updatedAt > current.updatedAt) attachmentById.set(row.id, row);
  }
  for (const attachment of attachmentById.values()) {
    if (attachment.deleted) continue;
    const block = postBlockById.get(attachment.blockId);
    const note = noteById.get(attachment.noteId);
    const blockPlace =
      block && !block.deleted && block.content?.type === "place"
        ? block.content.placeId
        : undefined;
    if (
      !blockPlace ||
      !note ||
      note.deleted ||
      note.target?.kind !== "place" ||
      note.target.placeId !== blockPlace ||
      note.shareable !== true
    ) {
      throw new Error(
        `merging would leave attachment ${attachment.id} joining a note to a block about a different place — refusing`,
      );
    }
  }
}

/** Structural zod checks pass `.loose()` fields through; coordinates get their own gate. */
export function validateCoordinates(data: BackupData): void {
  for (const place of data.places) {
    const row = place as { id: string; manual?: CoordinateFacts } & {
      firstSeen?: CoordinateFacts;
      lastVerified?: CoordinateFacts;
    };
    for (const facts of [row.manual, row.firstSeen, row.lastVerified]) {
      if (facts && !coordinatesInRange(facts)) {
        throw new Error(`place ${row.id} has an out-of-range coordinate — refusing to import`);
      }
    }
  }
}
