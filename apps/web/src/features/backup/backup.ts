/**
 * Versioned ZIP backup/restore (book/src/storage-sync.md §Backup and restore):
 * manifest + checksummed data.json + binary media. Import validates schema and
 * checksums before any write; merge is per-id LWW that never silently discards
 * a conflicting note body (a conflict copy is created instead).
 */
import { type Note, type OsmElementRef, refKey } from "@placemarks/domain";
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
  // Every media entry must be declared and match its declared checksum, and every
  // declared entry must be present — before any write happens.
  for (const [name, fileBytes] of Object.entries(entries)) {
    if (!name.startsWith("media/")) continue;
    const declared = manifest.checksums[name];
    if (!declared) throw new Error(`backup contains undeclared media entry ${name}`);
    if ((await sha256Hex(fileBytes)) !== declared) {
      throw new Error(`${name} failed its checksum — refusing to import`);
    }
  }
  for (const name of Object.keys(manifest.checksums)) {
    if (name !== "data.json" && !entries[name]) {
      throw new Error(`backup is missing declared entry ${name}`);
    }
  }
  const data = dataSchema.parse(JSON.parse(strFromU8(dataBytes)));
  validateCoordinates(data);

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
        // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
        await (table as any).bulkPut(data[key] as any[]);
        imported += data[key].length;
      }
    } else {
      // Identity merge (book/src/place-identity.md): the same exact OSM element —
      // by current or historical ref — must not become two library places.
      // Incoming duplicates are dropped and their edges rewritten to the retained
      // PlaceId before the per-id merge.
      const keysOf = (row: {
        refKeys?: string[];
        currentOsmRef?: OsmElementRef;
        osmRefHistory?: { ref: OsmElementRef }[];
      }): string[] =>
        row.refKeys ?? [
          ...(row.currentOsmRef ? [refKey(row.currentOsmRef)] : []),
          ...(row.osmRefHistory ?? []).map((entry) => refKey(entry.ref)),
        ];
      const existingByRefKey = new Map<string, string>();
      for (const row of await db.places.toArray()) {
        if (row.deleted) continue;
        for (const key of keysOf(row)) existingByRefKey.set(key, row.id);
      }
      const remap = new Map<string, string>();
      data.places = data.places.filter((place) => {
        const row = place as unknown as {
          id: string;
          deleted?: boolean;
          refKeys?: string[];
          currentOsmRef?: OsmElementRef;
          osmRefHistory?: { ref: OsmElementRef }[];
        };
        if (row.deleted) return true;
        const retained = keysOf(row)
          .map((key) => existingByRefKey.get(key))
          .find((id) => id !== undefined && id !== row.id);
        if (!retained) return true;
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
