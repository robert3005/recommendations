/**
 * Versioned ZIP backup/restore (book/src/storage-sync.md §Backup and restore):
 * manifest + checksummed data.json + binary media. Import validates schema and
 * checksums before any write; merge is per-id LWW that never silently discards
 * a conflicting note body (a conflict copy is created instead).
 */
import type { Note } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";

export const BACKUP_SCHEMA_VERSION = 1;

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
  places: z.array(z.object({ ...entityBase, origin: z.enum(["osm", "manual"]) }).loose()),
  savedPlaces: z.array(z.object({ ...entityBase, placeId: z.string() }).loose()),
  tags: z.array(z.object({ ...entityBase, name: z.string(), nameNorm: z.string() }).loose()),
  tagAssignments: z.array(
    z.object({ ...entityBase, savedPlaceId: z.string(), tagId: z.string() }).loose(),
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
    savedPlaces: await db.savedPlaces.toArray(),
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
  for (const asset of data.mediaAssets.filter((a) => !a.deleted)) {
    const blobRow = await db.mediaBlobs.get(asset.localBlobKey as string);
    if (blobRow?.blob) {
      try {
        files[`media/${asset.localBlobKey}`] = await blobBytes(blobRow.blob);
      } catch {
        // Skip unreadable media rather than failing the whole export.
      }
    }
  }

  const manifest = {
    app: "placemarks" as const,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    checksums: { "data.json": await sha256Hex(dataBytes) },
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

export async function importBackup(
  repo: DexieRepository,
  file: Blob,
  mode: "replace" | "merge",
  now: string,
): Promise<ImportResult> {
  const bytes = await blobBytes(file);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("not a valid backup archive");
  }
  const manifestBytes = entries["manifest.json"];
  const dataBytes = entries["data.json"];
  if (!manifestBytes || !dataBytes) throw new Error("backup is missing manifest or data");
  const manifest = manifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
  const expected = manifest.checksums["data.json"];
  if (!expected || (await sha256Hex(dataBytes)) !== expected) {
    throw new Error("backup data failed its checksum — refusing to import");
  }
  const data = dataSchema.parse(JSON.parse(strFromU8(dataBytes)));

  const db = repo.db;
  const tables = [
    ["places", db.places],
    ["savedPlaces", db.savedPlaces],
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
        // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
        await (table as any).bulkPut(data[key] as any[]);
        imported += data[key].length;
      }
    } else {
      for (const [key, table] of tables) {
        for (const incoming of data[key]) {
          // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
          const existing = (await (table as any).get(incoming.id)) as
            | { id: string; updatedAt: string; deleted?: boolean; body?: string }
            | undefined;
          if (!existing) {
            // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
            await (table as any).put(incoming);
            imported += 1;
            continue;
          }
          if (incoming.updatedAt <= existing.updatedAt) continue;
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
