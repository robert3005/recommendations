/**
 * Versioned ZIP backup/restore (spec/src/storage-sync.md §Backup and restore):
 * manifest + checksummed data.json + binary media. Import validates schema and
 * checksums before any write; merge is per-id LWW that never silently discards
 * a conflicting note body (a conflict copy is created instead).
 */
import {
  allRefKeys,
  markerKey,
  type Note,
  type OsmElementRef,
  type Place,
} from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import {
  type PivotAttachmentRow,
  type PivotBlockRow,
  type PivotListRow,
  type PivotNoteRow,
  pivotGuideLayer,
} from "../../data/pivot";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";

/** v3 (2026-07-19 pivot): lists carry markers; posts and their edges join the archive. */
export const BACKUP_SCHEMA_VERSION = 3;

const entityBase = {
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deleted: z.boolean().optional(),
};

const manifestSchema = z.object({
  app: z.literal("placemarks"),
  // Pre-pivot (v2) archives restore losslessly: the guide layer they carry is
  // pivoted onto posts on import (spec/src/posts.md §Migration).
  schemaVersion: z.union([z.literal(2), z.literal(BACKUP_SCHEMA_VERSION)]),
  exportedAt: z.string(),
  checksums: z.record(z.string(), z.string()),
  counts: z.record(z.string(), z.number()),
  source: z.object({
    attribution: z.literal("© OpenStreetMap contributors"),
    license: z.literal("ODbL-1.0"),
  }),
});

// Structural validation; domain invariants are enforced by the repository layer.
const dataSchema = z.object({
  places: z.array(z.object({ ...entityBase, origin: z.enum(["osm", "manual", "import"]) }).loose()),
  tags: z.array(z.object({ ...entityBase, name: z.string(), nameNorm: z.string() }).loose()),
  tagAssignments: z.array(
    z.object({ ...entityBase, placeId: z.string(), tagId: z.string() }).loose(),
  ),
  notes: z.array(z.object({ ...entityBase, body: z.string(), targetKey: z.string() }).loose()),
  mediaAssets: z.array(z.object({ ...entityBase, localBlobKey: z.string() }).loose()),
  lists: z.array(z.object({ ...entityBase, name: z.string() }).loose()),
  listBlocks: z.array(z.object({ ...entityBase, listId: z.string(), rank: z.string() }).loose()),
  // Absent in v2 archives; defaulted so one schema serves both versions.
  posts: z
    .array(z.object({ ...entityBase, title: z.string(), listId: z.string() }).loose())
    .default([]),
  postBlocks: z
    .array(z.object({ ...entityBase, postId: z.string(), rank: z.string() }).loose())
    .default([]),
  blockNoteAttachments: z.array(
    z.object({ ...entityBase, blockId: z.string(), noteId: z.string() }).loose(),
  ),
  blockTagSelections: z
    .array(z.object({ ...entityBase, blockId: z.string(), tagId: z.string() }).loose())
    .default([]),
});

export type BackupData = z.infer<typeof dataSchema>;

/**
 * Restore a pre-pivot (v2) archive into the post-pivot model: lists gain
 * markers, the guide layer moves onto posts, list notes retarget, attachments
 * follow. Derived pivot ids make this converge with a library that migrated
 * locally — no duplicate posts on merge.
 */
function pivotBackupData(data: BackupData, now: string): void {
  const changes = pivotGuideLayer({
    lists: data.lists as unknown as PivotListRow[],
    listBlocks: data.listBlocks as unknown as PivotBlockRow[],
    notes: data.notes as unknown as PivotNoteRow[],
    blockNoteAttachments: data.blockNoteAttachments as unknown as PivotAttachmentRow[],
  });
  for (const list of data.lists as unknown as (PivotListRow & Record<string, unknown>)[]) {
    const marker = changes.markers.get(list.id);
    if (marker) {
      list.marker = marker;
      delete list.color;
      delete list.icon;
    }
  }
  for (const post of changes.posts) {
    data.posts.push({ ...post, createdAt: now, updatedAt: now });
  }
  for (const block of changes.postBlocks) {
    data.postBlocks.push({
      id: block.id,
      postId: block.postId,
      rank: block.rank,
      kind: block.kind,
      refId: block.refId,
      content:
        block.kind === "section"
          ? { type: "section", noteId: block.refId }
          : { type: "place", placeId: block.refId },
      createdAt: now,
      updatedAt: now,
    });
  }
  const tombstoned = new Set(changes.tombstoneListBlockIds);
  for (const block of data.listBlocks as unknown as (PivotBlockRow & {
    updatedAt: string;
  })[]) {
    if (tombstoned.has(block.id)) {
      block.deleted = true;
      block.updatedAt = now;
    }
  }
  for (const note of data.notes as unknown as (PivotNoteRow & {
    target?: unknown;
    updatedAt: string;
  })[]) {
    const postId = changes.retargetNotes.get(note.id);
    if (postId) {
      note.target = { kind: "post", postId };
      note.targetKey = `post:${postId}`;
      note.updatedAt = now;
    }
  }
  for (const attachment of data.blockNoteAttachments as unknown as (PivotAttachmentRow & {
    updatedAt: string;
  })[]) {
    const blockId = changes.moveAttachments.get(attachment.id);
    if (blockId) {
      attachment.blockId = blockId;
      attachment.updatedAt = now;
    }
  }
}

/** Blob → bytes with a FileReader fallback (jsdom Blobs may lack arrayBuffer()). */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function exportBackup(repo: DexieRepository, exportedAt: string): Promise<Blob> {
  const db = repo.db;
  const data: BackupData = {
    places: await db.places.toArray(),
    tags: await db.tags.toArray(),
    tagAssignments: await db.tagAssignments.toArray(),
    notes: await db.notes.toArray(),
    mediaAssets: await db.mediaAssets.toArray(),
    lists: await db.lists.toArray(),
    listBlocks: await db.listBlocks.toArray(),
    posts: await db.posts.toArray(),
    postBlocks: await db.postBlocks.toArray(),
    blockNoteAttachments: await db.blockNoteAttachments.toArray(),
    blockTagSelections: await db.blockTagSelections.toArray(),
  } as unknown as BackupData;
  const dataBytes = strToU8(JSON.stringify(data));

  const files: Record<string, Uint8Array> = { "data.json": dataBytes };
  const checksums: Record<string, string> = { "data.json": await sha256Hex(dataBytes) };
  // Fail closed: an apparently complete archive with silently omitted media is
  // worse than no archive (spec/src/storage-sync.md §Backup and restore).
  for (const asset of data.mediaAssets.filter((a) => !a.deleted)) {
    const blobRow = await db.mediaBlobs.get(asset.localBlobKey as string);
    if (!blobRow?.blob) {
      throw new Error(`media bytes are missing for asset ${asset.id} — export refused`);
    }
    const name = `media/${asset.localBlobKey}`;
    files[name] = await blobBytes(blobRow.blob);
    checksums[name] = await sha256Hex(files[name]);
  }

  const manifest = {
    app: "placemarks" as const,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    checksums,
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    source: { attribution: "© OpenStreetMap contributors", license: "ODbL-1.0" } as const,
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  // A successful export must be restorable: refuse up front when the COMPLETE
  // archive — manifest included — would exceed the import resource caps.
  let inflatedTotal = 0;
  for (const fileBytes of Object.values(files)) inflatedTotal += fileBytes.byteLength;
  if (inflatedTotal > INFLATED_BYTE_LIMIT) {
    throw new Error(
      `this library is ${Math.ceil(inflatedTotal / (1024 * 1024))} MiB uncompressed — over the ` +
        `${INFLATED_BYTE_LIMIT / (1024 * 1024)} MiB restore size limit; export refused`,
    );
  }
  if (Object.keys(files).length > ARCHIVE_ENTRY_LIMIT) {
    throw new Error("this library exceeds the archive entry limit — export refused");
  }

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

export interface ImportResult {
  mode: "replace" | "merge";
  imported: number;
  conflictCopies: number;
}

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
function validateGraph(
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
    // Linkage only ever gains OSM identity: an OSM-origin place always keeps
    // a current binding — evidence without one is a malformed identity.
    if ((place as { origin?: string }).origin === "osm" && !row.currentOsmRef) {
      throw new Error(
        `place ${row.id} claims OSM origin but has no current binding — refusing to import`,
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
    if ((place as { origin?: string }).origin === "osm" && (!row.firstSeen || !row.lastVerified)) {
      throw new Error(
        `place ${row.id} claims OSM origin without binding or copied evidence — refusing to import`,
      );
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
    // Tag selections: a post place block, and a tag actually assigned to that
    // block's place; one live selection per (block, tag).
    const selectionPairs = new Set<string>();
    for (const selection of data.blockTagSelections) {
      const row = selection as unknown as {
        id: string;
        deleted?: boolean;
        blockId: string;
        tagId: string;
      };
      if (row.deleted) continue;
      const pair = `${row.blockId}::${row.tagId}`;
      if (selectionPairs.has(pair)) {
        throw new Error(`duplicate live tag selection for block ${row.blockId} — graph refused`);
      }
      selectionPairs.add(pair);
      const block = postBlocksById.get(row.blockId);
      if (block?.content?.type !== "place") {
        throw new Error(`tag selection ${row.id} names no live post place block — graph refused`);
      }
      if (!liveTags.has(row.tagId)) {
        throw new Error(`tag selection ${row.id} references a missing tag — graph refused`);
      }
      if (!assignmentPairs.has(`${block.content.placeId ?? ""}::${row.tagId}`)) {
        throw new Error(
          `tag selection ${row.id} selects a tag not assigned to the embed's place — graph refused`,
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
function canonicalKeys(row: {
  currentOsmRef?: { type: string; id: string };
  osmRefHistory?: { ref: { type: string; id: string } }[];
}): string[] {
  return [
    ...(row.currentOsmRef ? [`${row.currentOsmRef.type}/${row.currentOsmRef.id}`] : []),
    ...(row.osmRefHistory ?? []).map((entry) => `${entry.ref.type}/${entry.ref.id}`),
  ];
}

async function validateMergeIdentities(repo: DexieRepository, data: BackupData): Promise<void> {
  const keysOf = canonicalKeys;
  for (const place of data.places) {
    const row = place as unknown as {
      id: string;
      deleted?: boolean;
      refKeys?: string[];
      currentOsmRef?: { type: string; id: string };
      osmRefHistory?: { ref: { type: string; id: string } }[];
    };
    if (row.deleted) continue;
    const existing = await repo.getPlace(row.id);
    if (!existing) continue;
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
async function validateMergeFinalGraph(repo: DexieRepository, data: BackupData): Promise<void> {
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
  for (const tag of tagById.values()) liveTags.set(tag.id, !tag.deleted);
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

  // Tag selections survive only on live post place blocks whose place still
  // carries the selected tag's live assignment.
  const finalAssignmentPairs = new Set<string>();
  for (const edge of assignments.values()) {
    if (!edge.deleted) finalAssignmentPairs.add(`${edge.placeId}::${edge.tagId}`);
  }
  type SelectionLike = Aged & { blockId: string; tagId: string };
  const selectionById = lww(
    (await repo.db.blockTagSelections.toArray()) as unknown as SelectionLike[],
    data.blockTagSelections as unknown as SelectionLike[],
  );
  for (const selection of selectionById.values()) {
    if (selection.deleted) continue;
    const block = postBlockById.get(selection.blockId);
    const blockPlace =
      block && !block.deleted && block.content?.type === "place"
        ? block.content.placeId
        : undefined;
    if (!blockPlace || !finalAssignmentPairs.has(`${blockPlace}::${selection.tagId}`)) {
      throw new Error(
        `merging would leave tag selection ${selection.id} without its assignment — refusing`,
      );
    }
  }
}

/** Structural zod checks pass `.loose()` fields through; coordinates get their own gate. */
function validateCoordinates(data: BackupData): void {
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

/** Import resource caps (spec/src/storage-sync.md: archive bytes, entry count, inflated bytes). */
export const ARCHIVE_BYTE_LIMIT = 256 * 1024 * 1024;
export const ARCHIVE_ENTRY_LIMIT = 4096;
export const INFLATED_BYTE_LIMIT = 48 * 1024 * 1024;

/** The ZIP end-of-central-directory record, scanned from the tail. */
function findEocd(bytes: Uint8Array): number {
  const scanFrom = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= scanFrom; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
  (bytes[at + 3] ?? 0) * 0x1000000;

/**
 * The bounds the ZIP central directory itself declares — parsed strictly and
 * BEFORE any decompression. A directory that cannot be walked as declared is
 * "invalid", never interpreted as declaring zero.
 */
function declaredZipDirectory(
  bytes: Uint8Array,
): { entryCount: number; inflatedTotal: number } | "invalid" {
  const eocd = findEocd(bytes);
  // No end-of-central-directory record means no declared bounds to trust.
  if (eocd < 0) return "invalid";
  const entryCount = u16(bytes, eocd + 10);
  const declaredSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  let offset = cdOffset;
  let inflatedTotal = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) return "invalid";
    inflatedTotal += u32(bytes, offset + 24);
    offset += 46 + u16(bytes, offset + 28) + u16(bytes, offset + 30) + u16(bytes, offset + 32);
  }
  // Every EOCD declaration must agree with the walk: the record count must
  // consume exactly the declared central-directory span ending at the EOCD.
  if (offset !== eocd || offset - cdOffset !== declaredSize) return "invalid";
  return { entryCount, inflatedTotal };
}

export async function importBackup(
  repo: DexieRepository,
  file: Blob,
  mode: "replace" | "merge",
  now: string,
): Promise<ImportResult> {
  if (file.size > ARCHIVE_BYTE_LIMIT) {
    throw new Error("backup archive is too large — refusing to read it");
  }
  const bytes = await blobBytes(file);
  // Declared bounds are enforced before any decompression work — and a
  // directory that cannot be walked as declared is refused outright.
  const declared = declaredZipDirectory(bytes);
  if (declared === "invalid") {
    throw new Error("not a valid backup archive — the ZIP central directory is missing or invalid");
  }
  if (declared.entryCount > ARCHIVE_ENTRY_LIMIT) {
    throw new Error("backup entry count exceeds the limit — refusing to import");
  }
  if (declared.inflatedTotal > INFLATED_BYTE_LIMIT) {
    throw new Error("backup declares an uncompressed size beyond the limit — refusing to import");
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("not a valid backup archive");
  }
  // The central directory's own entry count also bounds the archive — the
  // keyed extraction collapses duplicate member names and would undercount.
  const names = Object.keys(entries);
  if (names.length > ARCHIVE_ENTRY_LIMIT) {
    throw new Error("backup entry count exceeds the limit — refusing to import");
  }
  let inflated = 0;
  for (const name of names) inflated += entries[name]?.length ?? 0;
  if (inflated > INFLATED_BYTE_LIMIT) {
    throw new Error("backup inflates beyond the size limit — refusing to import");
  }
  const manifestBytes = entries["manifest.json"];
  const dataBytes = entries["data.json"];
  if (!manifestBytes || !dataBytes) throw new Error("backup is missing manifest or data");
  const manifest = manifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
  const expected = manifest.checksums["data.json"];
  if (!expected || (await sha256Hex(dataBytes)) !== expected) {
    throw new Error("backup data failed its checksum — refusing to import");
  }
  // Every declared checksum is verified and every entry (bar the manifest
  // itself) must be declared — before any write happens.
  for (const [name, fileBytes] of Object.entries(entries)) {
    if (name === "manifest.json") continue;
    if (!manifest.checksums[name]) {
      throw new Error(`backup contains undeclared entry ${name}`);
    }
    if ((await sha256Hex(fileBytes)) !== manifest.checksums[name]) {
      throw new Error(`${name} failed its checksum — refusing to import`);
    }
  }
  for (const name of Object.keys(manifest.checksums)) {
    if (!entries[name]) throw new Error(`backup is missing declared entry ${name}`);
  }
  const data = dataSchema.parse(JSON.parse(strFromU8(dataBytes)));
  // Manifest counts must exactly describe the payload they attest to (tables
  // a v2 archive predates count as zero).
  for (const [table, tableRows] of Object.entries(data)) {
    if ((manifest.counts[table] ?? 0) !== (tableRows as unknown[]).length) {
      throw new Error(`manifest count for ${table} does not match data.json — refusing to import`);
    }
  }
  // A pre-pivot archive restores into the post-pivot model losslessly.
  if (manifest.schemaVersion === 2) pivotBackupData(data, now);
  validateCoordinates(data);
  validateGraph(data, entries, mode);
  if (mode === "merge") {
    await validateMergeIdentities(repo, data);
    await validateMergeFinalGraph(repo, data);
  }

  const db = repo.db;
  const tables = [
    ["places", db.places],
    ["tags", db.tags],
    ["tagAssignments", db.tagAssignments],
    ["notes", db.notes],
    ["mediaAssets", db.mediaAssets],
    ["lists", db.lists],
    ["listBlocks", db.listBlocks],
    ["posts", db.posts],
    ["postBlocks", db.postBlocks],
    ["blockNoteAttachments", db.blockNoteAttachments],
    ["blockTagSelections", db.blockTagSelections],
  ] as const;

  let imported = 0;
  let conflictCopies = 0;
  // Every row the restore actually writes syncs like any other local edit
  // (spec/src/storage-sync.md) — skipped merge duplicates never re-enter the
  // log under a fresh stamp.
  const written: { table: string; row: { id: string } }[] = [];

  await db.transaction(
    "rw",
    [...tables.map(([, t]) => t), db.mediaBlobs, db.mutationOutbox, db.syncRevs],
    async () => {
      if (mode === "replace") {
        for (const [, table] of tables) await table.clear();
        await db.mediaBlobs.clear();
        for (const [key, table] of tables) {
          // Derived index fields are recomputed, never trusted: stale refKeys in
          // an archive could fork the same exact OSM identity after restore.
          const rows =
            key === "places"
              ? data[key].map((row) => ({
                  ...row,
                  refKeys: allRefKeys(row as unknown as Place),
                }))
              : data[key];
          // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
          await (table as any).bulkPut(rows as any[]);
          for (const row of rows as { id: string }[]) written.push({ table: key, row });
          imported += data[key].length;
        }
      } else {
        // Identity merge (spec/src/place-identity.md): the same exact OSM element —
        // by current or historical ref — must not become two library places.
        // Incoming duplicates are dropped and their edges rewritten to the retained
        // PlaceId before the per-id merge.
        const existingByRefKey = new Map<string, string>();
        for (const row of await db.places.toArray()) {
          if (row.deleted) continue;
          for (const key of canonicalKeys(row)) existingByRefKey.set(key, row.id);
        }
        const remap = new Map<string, string>();
        const incomingByRefKey = new Map<string, string>();
        type EvidenceLike = { observedAt: string };
        type PlaceShape = {
          id: string;
          deleted?: boolean;
          currentOsmRef?: OsmElementRef;
          osmRefHistory?: { ref: OsmElementRef }[];
          firstSeen?: EvidenceLike;
          lastVerified?: EvidenceLike;
        };
        const evidenceDonors: { retainedId: string; donor: PlaceShape }[] = [];
        data.places = data.places.filter((place) => {
          const row = place as unknown as PlaceShape;
          if (row.deleted) return true;
          const keys = canonicalKeys(row);
          // The same exact OSM element must not arrive twice under two ids —
          // nor collide with a different retained local place.
          const retained =
            keys.map((key) => existingByRefKey.get(key)).find((id) => id && id !== row.id) ??
            keys.map((key) => incomingByRefKey.get(key)).find((id) => id && id !== row.id);
          if (!retained) {
            for (const key of keys) incomingByRefKey.set(key, row.id);
            return true;
          }
          remap.set(row.id, retained);
          evidenceDonors.push({ retainedId: retained, donor: row });
          return false;
        });
        // Coalescing must never discard the dropped row's newer observation —
        // the retained place keeps the earliest firstSeen and latest lastVerified.
        for (const { retainedId, donor } of evidenceDonors) {
          const graft = (target: PlaceShape): boolean => {
            let changed = false;
            if (
              donor.lastVerified &&
              (!target.lastVerified ||
                donor.lastVerified.observedAt > target.lastVerified.observedAt)
            ) {
              target.lastVerified = donor.lastVerified;
              changed = true;
            }
            if (
              donor.firstSeen &&
              (!target.firstSeen || donor.firstSeen.observedAt < target.firstSeen.observedAt)
            ) {
              target.firstSeen = donor.firstSeen;
              changed = true;
            }
            return changed;
          };
          const incomingRetained = data.places.find((p) => p.id === retainedId) as
            | PlaceShape
            | undefined;
          if (incomingRetained) {
            graft(incomingRetained);
            continue;
          }
          const existingRetained = (await db.places.get(retainedId)) as unknown as
            | (PlaceShape & Place)
            | undefined;
          if (existingRetained && !existingRetained.deleted && graft(existingRetained)) {
            const grafted = {
              ...existingRetained,
              refKeys: allRefKeys(existingRetained as unknown as Place),
            };
            await db.places.put(grafted as never);
            written.push({ table: "places", row: grafted as { id: string } });
          }
        }
        if (remap.size > 0) {
          for (const assignment of data.tagAssignments) {
            const target = remap.get(assignment.placeId);
            if (target) assignment.placeId = target;
          }
          for (const block of [...data.listBlocks, ...data.postBlocks]) {
            const row = block as unknown as {
              kind?: string;
              refId?: string;
              content?: { type?: string; placeId?: string };
            };
            if (row.kind !== "place" || !row.refId) continue;
            const target = remap.get(row.refId);
            if (!target) continue;
            row.refId = target;
            if (row.content?.type === "place") row.content.placeId = target;
          }
          for (const note of data.notes) {
            const row = note as unknown as {
              target?: { kind?: string; placeId?: string };
              targetKey?: string;
            };
            if (row.target?.kind !== "place" || !row.target.placeId) continue;
            const target = remap.get(row.target.placeId);
            if (!target) continue;
            row.target.placeId = target;
            row.targetKey = `place:${target}`;
          }
        }

        const skippedBlockTargets = new Map<string, string>();
        for (const [key, table] of tables) {
          for (const incoming of data[key]) {
            // Rewritten edges must not violate repository uniqueness invariants:
            // one live block per (listId, placeId), one live (placeId, tagId) pair.
            if (key === "listBlocks") {
              const row = incoming as unknown as {
                id: string;
                listId: string;
                kind?: string;
                refId?: string;
                deleted?: boolean;
              };
              if (!row.deleted && row.kind === "place" && row.refId) {
                const siblings = await db.listBlocks.where("listId").equals(row.listId).toArray();
                const clash = siblings.find(
                  (b) =>
                    !b.deleted && b.kind === "place" && b.refId === row.refId && b.id !== row.id,
                );
                if (clash) {
                  // The membership already exists locally — the incoming
                  // duplicate is skipped and its dependents follow the retained
                  // block instead of dangling.
                  skippedBlockTargets.set(row.id, clash.id);
                  continue;
                }
              }
            }
            if (key === "postBlocks") {
              const row = incoming as unknown as {
                id: string;
                postId: string;
                kind?: string;
                refId?: string;
                deleted?: boolean;
              };
              if (!row.deleted && row.kind === "place" && row.refId) {
                const siblings = await db.postBlocks.where("postId").equals(row.postId).toArray();
                const clash = siblings.find(
                  (b) =>
                    !b.deleted && b.kind === "place" && b.refId === row.refId && b.id !== row.id,
                );
                if (clash) {
                  // The embed already exists (possibly via identity remapping) —
                  // the incoming duplicate is skipped and its dependents follow
                  // the retained block instead of dangling.
                  skippedBlockTargets.set(row.id, clash.id);
                  continue;
                }
              }
            }
            if (key === "tagAssignments") {
              const row = incoming as unknown as {
                id: string;
                placeId: string;
                tagId: string;
                deleted?: boolean;
              };
              if (!row.deleted) {
                const pairs = await db.tagAssignments
                  .where("[placeId+tagId]")
                  .equals([row.placeId, row.tagId])
                  .toArray();
                const clash = pairs.find((a) => !a.deleted && a.id !== row.id);
                if (clash) continue;
              }
            }
            if (key === "blockTagSelections") {
              const row = incoming as unknown as {
                id: string;
                blockId: string;
                tagId: string;
                deleted?: boolean;
              };
              // Follow a skipped duplicate embed onto its retained block.
              const retainedBlock = skippedBlockTargets.get(row.blockId);
              if (retainedBlock) row.blockId = retainedBlock;
              if (!row.deleted) {
                const edges = await db.blockTagSelections.toArray();
                const clash = edges.find(
                  (edge) =>
                    !edge.deleted &&
                    edge.blockId === row.blockId &&
                    edge.tagId === row.tagId &&
                    edge.id !== row.id,
                );
                if (clash) continue;
              }
            }
            if (key === "blockNoteAttachments") {
              const row = incoming as unknown as {
                id: string;
                blockId: string;
                noteId: string;
                deleted?: boolean;
              };
              // Follow a skipped duplicate membership onto its retained block.
              const retainedBlock = skippedBlockTargets.get(row.blockId);
              if (retainedBlock) row.blockId = retainedBlock;
              if (!row.deleted) {
                // One live edge per (block, note) — a re-identified duplicate
                // from another device must not double the attachment.
                const edges = await db.blockNoteAttachments.toArray();
                const clash = edges.find(
                  (edge) =>
                    !edge.deleted &&
                    edge.blockId === row.blockId &&
                    edge.noteId === row.noteId &&
                    edge.id !== row.id,
                );
                if (clash) continue;
              }
            }
            // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
            const existing = (await (table as any).get(incoming.id)) as
              | { id: string; updatedAt: string; deleted?: boolean; body?: string }
              | undefined;
            if (!existing) {
              if (key === "places") {
                (incoming as { refKeys?: string[] }).refKeys = allRefKeys(
                  incoming as unknown as Place,
                );
              }
              // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
              await (table as any).put(incoming);
              written.push({ table: key, row: incoming as { id: string } });
              imported += 1;
              continue;
            }
            if (incoming.updatedAt <= existing.updatedAt) {
              // A conflicting note body is NEVER silently discarded — even when
              // the incoming side loses last-write-wins, its body survives as a
              // recoverable conflict copy (spec/src/storage-sync.md).
              if (
                key === "notes" &&
                !existing.deleted &&
                !incoming.deleted &&
                existing.body !== undefined &&
                (incoming as { body?: string }).body !== undefined &&
                (incoming as { body?: string }).body !== existing.body
              ) {
                const copy: Note & { targetKey: string } = {
                  ...(incoming as unknown as Note & { targetKey: string }),
                  id: newId(),
                  title: `(conflict copy) ${(incoming as { title?: string }).title ?? ""}`.trim(),
                  updatedAt: now,
                };
                await db.notes.put(copy);
                written.push({ table: "notes", row: copy });
                conflictCopies += 1;
              }
              continue;
            }
            // Same derived-index rule as replace mode: recompute, never trust.
            if (key === "places") {
              (incoming as { refKeys?: string[] }).refKeys = allRefKeys(
                incoming as unknown as Place,
              );
            }
            // Never silently discard a conflicting note body.
            if (
              key === "notes" &&
              !existing.deleted &&
              !incoming.deleted &&
              existing.body !== undefined &&
              (incoming as { body?: string }).body !== existing.body
            ) {
              const copy: Note & { targetKey: string } = {
                ...(existing as unknown as Note & { targetKey: string }),
                id: newId(),
                title: `(conflict copy) ${(existing as { title?: string }).title ?? ""}`.trim(),
                updatedAt: now,
              };
              await db.notes.put(copy);
              written.push({ table: "notes", row: copy });
              conflictCopies += 1;
            }
            // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
            await (table as any).put(incoming);
            written.push({ table: key, row: incoming as { id: string } });
            imported += 1;
          }
        }
      }
      // Restore media bytes (replace) / add missing (merge).
      for (const [name, fileBytes] of Object.entries(entries)) {
        if (!name.startsWith("media/")) continue;
        const key = name.slice("media/".length);
        const existing = mode === "merge" ? await db.mediaBlobs.get(key) : undefined;
        if (!existing) {
          await db.mediaBlobs.put({
            id: key,
            blob: new Blob([fileBytes.slice().buffer as ArrayBuffer]),
          });
        }
      }
      // Restored rows enter the sync outbox in the same transaction — a restore
      // on a synced device propagates like any other edit.
      await repo.logRestoredRows(written);
    },
  );

  return { mode, imported, conflictCopies };
}
