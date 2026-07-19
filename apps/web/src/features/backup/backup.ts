/**
 * Versioned ZIP backup/restore (book/src/storage-sync.md §Backup and restore):
 * manifest + checksummed data.json + binary media. Import validates schema and
 * checksums before any write; merge is per-id LWW that never silently discards
 * a conflicting note body (a conflict copy is created instead).
 */
import { allRefKeys, type Note, type OsmElementRef, type Place } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";

export const BACKUP_SCHEMA_VERSION = 2;

const entityBase = {
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deleted: z.boolean().optional(),
};

const manifestSchema = z.object({
  app: z.literal("placemarks"),
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
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
  blockNoteAttachments: z.array(
    z.object({ ...entityBase, blockId: z.string(), noteId: z.string() }).loose(),
  ),
});

export type BackupData = z.infer<typeof dataSchema>;

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
    blockNoteAttachments: await db.blockNoteAttachments.toArray(),
  } as unknown as BackupData;
  const dataBytes = strToU8(JSON.stringify(data));

  const files: Record<string, Uint8Array> = { "data.json": dataBytes };
  const checksums: Record<string, string> = { "data.json": await sha256Hex(dataBytes) };
  // Fail closed: an apparently complete archive with silently omitted media is
  // worse than no archive (book/src/storage-sync.md §Backup and restore).
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
 * Graph invariants before any write (book/src/storage-sync.md): every live
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
      firstSeen?: { ref?: RefLike };
      lastVerified?: { ref?: RefLike };
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
    // Every live note must target a live row — attached or not.
    for (const note of data.notes) {
      const row = note as {
        id: string;
        deleted?: boolean;
        target?: { kind?: string; listId?: string; placeId?: string };
      };
      if (row.deleted) continue;
      const targetLive =
        row.target?.kind === "list"
          ? liveLists.has(row.target.listId ?? "")
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
        n as { deleted?: boolean; target?: { kind?: string; listId?: string; placeId?: string } },
      ]),
    );
    const blockPairs = new Set<string>();
    const blocksById = new Map<
      string,
      { listId: string; content?: { type?: string; placeId?: string; noteId?: string } }
    >();
    for (const block of data.listBlocks) {
      const row = block as unknown as {
        id: string;
        deleted?: boolean;
        listId: string;
        content?: { type?: string; placeId?: string; noteId?: string };
      };
      if (row.deleted) continue;
      blocksById.set(row.id, row);
      if (!liveLists.has(row.listId)) {
        throw new Error(`list block ${row.id} belongs to no live list — graph refused`);
      }
      if (row.content?.type === "place" && row.content.placeId) {
        const pair = `${row.listId}::${row.content.placeId}`;
        if (blockPairs.has(pair)) {
          throw new Error(
            `place appears twice in one list (${row.listId}) — a place may appear at most once per list`,
          );
        }
        blockPairs.add(pair);
      }
      if (row.content?.type === "section" && row.content.noteId) {
        const note = notesById.get(row.content.noteId);
        if (
          !note ||
          note.deleted ||
          note.target?.kind !== "list" ||
          note.target.listId !== row.listId
        ) {
          throw new Error(
            `section block ${row.id} and its note disagree about the owning list — graph refused`,
          );
        }
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
      const block = blocksById.get(row.blockId);
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
 * an update (book/src/place-identity.md).
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
  const liveLists = new Set<string>();
  for (const list of await repo.db.lists.toArray()) if (!list.deleted) liveLists.add(list.id);
  for (const list of data.lists) {
    const row = list as { id: string; deleted?: boolean };
    if (row.deleted) liveLists.delete(row.id);
    else liveLists.add(row.id);
  }
  // Blocks resolve per id with the same LWW rule the merge applies — an
  // incoming tombstone can remove the only membership an existing row grants.
  type BlockLike = {
    id: string;
    deleted?: boolean;
    listId: string;
    updatedAt: string;
    content?: { type?: string; placeId?: string };
  };
  const blockById = new Map<string, BlockLike>();
  for (const block of (await repo.db.listBlocks.toArray()) as unknown as BlockLike[]) {
    blockById.set(block.id, block);
  }
  for (const block of data.listBlocks as unknown as BlockLike[]) {
    const current = blockById.get(block.id);
    if (!current || block.updatedAt > current.updatedAt) blockById.set(block.id, block);
  }
  const membership = new Set<string>();
  for (const block of blockById.values()) {
    if (block.deleted || block.content?.type !== "place") continue;
    if (liveLists.has(block.listId) && block.content.placeId) {
      membership.add(block.content.placeId);
    }
  }
  const livePlaces = new Map<string, boolean>();
  for (const place of await repo.db.places.toArray()) livePlaces.set(place.id, !place.deleted);
  for (const place of data.places) {
    const row = place as { id: string; deleted?: boolean };
    livePlaces.set(row.id, !row.deleted);
  }
  for (const [placeId, isLive] of livePlaces) {
    if (isLive && !membership.has(placeId)) {
      throw new Error(
        `merging would leave place ${placeId} without a live list membership — refusing`,
      );
    }
  }
  // Tag edges must also survive the merge: a live assignment with no live tag
  // in the final state is a broken graph.
  const liveTags = new Map<string, boolean>();
  for (const tag of await repo.db.tags.toArray()) liveTags.set(tag.id, !tag.deleted);
  for (const tag of data.tags) {
    const row = tag as { id: string; deleted?: boolean };
    liveTags.set(row.id, !row.deleted);
  }
  const assignments = new Map<string, { tagId: string; deleted: boolean }>();
  for (const a of await repo.db.tagAssignments.toArray()) {
    assignments.set(a.id, { tagId: a.tagId, deleted: a.deleted === true });
  }
  for (const a of data.tagAssignments) {
    const row = a as { id: string; tagId: string; deleted?: boolean };
    assignments.set(row.id, { tagId: row.tagId, deleted: row.deleted === true });
  }
  for (const [id, edge] of assignments) {
    if (!edge.deleted && liveTags.get(edge.tagId) !== true) {
      throw new Error(`merging would leave tag assignment ${id} without a live tag — refusing`);
    }
  }
  // Attachments must also join consistently in the final state: a live edge
  // joins a live place block to a live note about the SAME place.
  type NoteLike = {
    id: string;
    deleted?: boolean;
    updatedAt: string;
    target?: { kind?: string; placeId?: string };
  };
  const noteById = new Map<string, NoteLike>();
  for (const note of (await repo.db.notes.toArray()) as unknown as NoteLike[]) {
    noteById.set(note.id, note);
  }
  for (const note of data.notes as unknown as NoteLike[]) {
    const current = noteById.get(note.id);
    if (!current || note.updatedAt > current.updatedAt) noteById.set(note.id, note);
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
    const block = blockById.get(attachment.blockId);
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
      note.target.placeId !== blockPlace
    ) {
      throw new Error(
        `merging would leave attachment ${attachment.id} joining a note to a block about a different place — refusing`,
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

/** Import resource caps (book/src/storage-sync.md: archive bytes, entry count, inflated bytes). */
export const ARCHIVE_BYTE_LIMIT = 256 * 1024 * 1024;
export const ARCHIVE_ENTRY_LIMIT = 4096;
export const INFLATED_BYTE_LIMIT = 48 * 1024 * 1024;

/** Entry count from the ZIP end-of-central-directory record (0 if not found). */
function declaredZipEntryCount(bytes: Uint8Array): number {
  const scanFrom = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= scanFrom; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return (bytes[i + 10] ?? 0) | ((bytes[i + 11] ?? 0) << 8);
    }
  }
  return 0;
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
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("not a valid backup archive");
  }
  // The central directory's own entry count also bounds the archive — the
  // keyed extraction collapses duplicate member names and would undercount.
  const names = Object.keys(entries);
  if (Math.max(names.length, declaredZipEntryCount(bytes)) > ARCHIVE_ENTRY_LIMIT) {
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
  // Manifest counts must exactly describe the payload they attest to.
  for (const [table, tableRows] of Object.entries(data)) {
    if (manifest.counts[table] !== (tableRows as unknown[]).length) {
      throw new Error(`manifest count for ${table} does not match data.json — refusing to import`);
    }
  }
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
    ["blockNoteAttachments", db.blockNoteAttachments],
  ] as const;

  let imported = 0;
  let conflictCopies = 0;

  await db.transaction("rw", [...tables.map(([, t]) => t), db.mediaBlobs], async () => {
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
        imported += data[key].length;
      }
    } else {
      // Identity merge (book/src/place-identity.md): the same exact OSM element —
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
      data.places = data.places.filter((place) => {
        const row = place as unknown as {
          id: string;
          deleted?: boolean;
          currentOsmRef?: OsmElementRef;
          osmRefHistory?: { ref: OsmElementRef }[];
        };
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
        return false;
      });
      if (remap.size > 0) {
        for (const assignment of data.tagAssignments) {
          const target = remap.get(assignment.placeId);
          if (target) assignment.placeId = target;
        }
        for (const block of data.listBlocks) {
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
                (b) => !b.deleted && b.kind === "place" && b.refId === row.refId && b.id !== row.id,
              );
              if (clash) continue;
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
            imported += 1;
            continue;
          }
          if (incoming.updatedAt <= existing.updatedAt) continue;
          // Same derived-index rule as replace mode: recompute, never trust.
          if (key === "places") {
            (incoming as { refKeys?: string[] }).refKeys = allRefKeys(incoming as unknown as Place);
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
            conflictCopies += 1;
          }
          // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
          await (table as any).put(incoming);
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
  });

  return { mode, imported, conflictCopies };
}
