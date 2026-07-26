/**
 * The archive's wire shape (spec/src/storage-sync.md §Backup and restore): the
 * manifest, the data payload, and the normalisation that strips the query-only
 * fields IndexedDB rows carry beside their canonical domain shape.
 */
import {
  allRefKeys,
  type Note,
  normalizeTagName,
  noteTargetKey,
  type Place,
} from "@placemarks/domain";
import { z } from "zod";

/** One archive format. Nothing has shipped, so no older archive exists. */
export const BACKUP_SCHEMA_VERSION = 1;

const entityBase = {
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deleted: z.boolean().optional(),
};

export const manifestSchema = z.object({
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
export const dataSchema = z.object({
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
});

export type BackupData = z.infer<typeof dataSchema>;

/**
 * IndexedDB rows carry a handful of query-only fields beside their canonical
 * domain shape.  An archive is allowed to carry those fields for round-trip
 * compatibility, but it is never allowed to choose their values: doing so can
 * make a row invisible to teardown and uniqueness queries even though its
 * canonical edge/target says something else.
 */
export function normalizeDerivedFields(data: BackupData): void {
  for (const place of data.places) {
    (place as { refKeys?: string[] }).refKeys = allRefKeys(place as unknown as Place);
  }
  for (const tag of data.tags) {
    (tag as { nameNorm: string }).nameNorm = normalizeTagName(tag.name);
  }
  for (const note of data.notes) {
    const row = note as unknown as Note & { targetKey: string };
    const target = (row as unknown as { target?: Record<string, unknown> }).target;
    if (
      target &&
      ((target.kind === "place" && typeof target.placeId === "string") ||
        (target.kind === "post" && typeof target.postId === "string"))
    ) {
      row.targetKey = noteTargetKey(row.target);
      continue;
    }
    throw new Error(`note ${row.id} targets no live row — its target shape is invalid`);
  }
  for (const block of data.listBlocks) {
    const row = block as unknown as {
      id: string;
      kind?: string;
      refId?: string;
      content?: { type?: string; placeId?: string; noteId?: string };
    };
    if (row.content?.type === "place" && typeof row.content.placeId === "string") {
      row.kind = "place";
      row.refId = row.content.placeId;
    } else if (row.content?.type === "section" && typeof row.content.noteId === "string") {
      // Only a tombstoned pre-pivot residue may reach storage with this shape;
      // graph validation below rejects a live section on a list.
      row.kind = "section";
      row.refId = row.content.noteId;
    } else {
      throw new Error(`list block ${row.id} has no valid content — graph refused`);
    }
  }
  for (const block of data.postBlocks) {
    const row = block as unknown as {
      id: string;
      kind?: string;
      refId?: string;
      content?: { type?: string; placeId?: string; noteId?: string };
    };
    if (row.content?.type === "place" && typeof row.content.placeId === "string") {
      row.kind = "place";
      row.refId = row.content.placeId;
    } else if (row.content?.type === "section" && typeof row.content.noteId === "string") {
      row.kind = "section";
      row.refId = row.content.noteId;
    } else {
      throw new Error(`post block ${row.id} has no valid content — graph refused`);
    }
  }
}
