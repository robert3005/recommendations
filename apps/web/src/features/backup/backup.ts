/**
 * Versioned ZIP backup/restore (spec/src/storage-sync.md §Backup and restore):
 * manifest + checksummed data.json + binary media. Import validates schema and
 * checksums before any write; merge is per-id LWW that never silently discards
 * a conflicting note body (a conflict copy is created instead).
 */
import { allRefKeys, type Note, noteTargetKey, type Place } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";
import {
  ARCHIVE_BYTE_LIMIT,
  ARCHIVE_ENTRY_LIMIT,
  blobBytes,
  declaredZipDirectory,
  INFLATED_BYTE_LIMIT,
  sha256Hex,
} from "./archive";
import {
  BACKUP_SCHEMA_VERSION,
  type BackupData,
  dataSchema,
  manifestSchema,
  normalizeDerivedFields,
} from "./schema";
import {
  canonicalKeys,
  mergePlaceVersions,
  validateCoordinates,
  validateGraph,
  validateMergeFinalGraph,
  validateMergeIdentities,
} from "./validate";

// The caps stay reachable from this module: they are part of the import contract.
export { ARCHIVE_BYTE_LIMIT, ARCHIVE_ENTRY_LIMIT, INFLATED_BYTE_LIMIT } from "./archive";
export { BACKUP_SCHEMA_VERSION, type BackupData } from "./schema";

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
  // Manifest counts must exactly describe the payload they attest to.
  for (const [table, tableRows] of Object.entries(data)) {
    if ((manifest.counts[table] ?? 0) !== (tableRows as unknown[]).length) {
      throw new Error(`manifest count for ${table} does not match data.json — refusing to import`);
    }
  }
  normalizeDerivedFields(data);
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
  ] as const;

  let imported = 0;
  let conflictCopies = 0;
  // Every row the restore actually writes syncs like any other local edit
  // (spec/src/storage-sync.md) — skipped merge duplicates never re-enter the
  // log under a fresh stamp.
  const written: { table: string; row: { id: string } }[] = [];

  await db.transaction(
    "rw",
    [
      ...tables.map(([, t]) => t),
      db.mediaBlobs,
      db.mutationOutbox,
      db.syncRevs,
      db.publications,
      db.publicationJobs,
    ],
    async () => {
      if (mode === "replace") {
        // Replacing the private graph invalidates every document projected
        // from it, even when an imported target happens to reuse the same id.
        // Preserve hosted-publication credentials long enough to queue a
        // durable DELETE; never leave the previous public guide/note serving
        // stale content after "Replace everything".
        for (const publication of await db.publications.toArray()) {
          const row = await db.publicationJobs.get(publication.id);
          if (publication.status === "revoked") {
            await db.publicationJobs.delete(publication.id);
            continue;
          }
          await db.publications.put({ ...publication, status: "revoking", updatedAt: now });
          // Setting `revoke` drops any pending publish; an existing revoke keeps
          // its key so the retry is the same request.
          await db.publicationJobs.put({
            publicationId: publication.id,
            revoke: row?.revoke ?? { key: newId(), createdAt: now, attempts: 0 },
          });
        }
        // Capture the old graph before clearing it.  Rows omitted by the
        // replacement are removals, not absence: synced peers need a durable
        // tombstone or their older live snapshot can return on the next pull.
        const previousRows = new Map<
          string,
          { id: string; updatedAt: string; deleted?: boolean }[]
        >();
        for (const [key, table] of tables) {
          previousRows.set(
            key,
            (await table.toArray()) as {
              id: string;
              updatedAt: string;
              deleted?: boolean;
            }[],
          );
        }
        for (const [, table] of tables) await table.clear();
        await db.mediaBlobs.clear();
        // Pending mutations and their revision stamps describe the graph that
        // was just replaced.  Clear both, then rebuild one coherent outbox and
        // revision set from the restored rows plus removal tombstones in this
        // same transaction.
        await db.mutationOutbox.clear();
        await db.syncRevs.clear();
        for (const [key, table] of tables) {
          const archiveRows = data[key] as { id: string; updatedAt: string; deleted?: boolean }[];
          const restoredIds = new Set(archiveRows.map((row) => row.id));
          const removalTombstones = (previousRows.get(key) ?? [])
            .filter((row) => !restoredIds.has(row.id))
            .map((row) => ({ ...row, deleted: true, updatedAt: now }));
          const rows = [...archiveRows, ...removalTombstones];
          // biome-ignore lint/suspicious/noExplicitAny: structural rows validated by zod
          await (table as any).bulkPut(rows as any[]);
          for (const row of rows as { id: string }[]) written.push({ table: key, row });
          imported += archiveRows.length;
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
        const evidenceDonors: { retainedId: string; donor: Place }[] = [];
        // Process the best-connected identity rows first. Registering every
        // key of a dropped bridge against its retained id makes transitive
        // chains (node/1 ↔ bridge ↔ way/2) converge independently of archive
        // order instead of leaving the far endpoint as a duplicate place.
        data.places = [...data.places]
          .sort((left, right) => {
            const keyDelta =
              canonicalKeys(right as unknown as Place).length -
              canonicalKeys(left as unknown as Place).length;
            return keyDelta !== 0 ? keyDelta : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
          })
          .filter((place) => {
            const row = place as unknown as Place;
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
            for (const key of keys) incomingByRefKey.set(key, retained);
            evidenceDonors.push({ retainedId: retained, donor: row });
            return false;
          });
        // Coalescing never discards immutable history, external provenance, or
        // a newer verified observation from the dropped identity.
        for (const { retainedId, donor } of evidenceDonors) {
          const incomingRetained = data.places.find((p) => p.id === retainedId) as
            | (Place & { refKeys?: string[] })
            | undefined;
          if (incomingRetained) {
            const merged = mergePlaceVersions(
              incomingRetained,
              donor,
              donor.updatedAt > incomingRetained.updatedAt,
              false,
            );
            Object.assign(incomingRetained, merged, { refKeys: allRefKeys(merged) });
            continue;
          }
          const existingRetained = await db.places.get(retainedId);
          if (existingRetained && !existingRetained.deleted) {
            const merged = mergePlaceVersions(
              existingRetained,
              donor,
              donor.updatedAt > existingRetained.updatedAt,
              false,
            );
            const grafted = {
              ...merged,
              refKeys: allRefKeys(merged),
            };
            await db.places.put(grafted);
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

        // Dependents point only at post blocks.  IDs are table-scoped, so a
        // skipped list membership with the same string id must never retarget
        // an attachment or tag selection meant for a post block.
        const skippedPostBlockTargets = new Map<string, string>();
        for (const [key, table] of tables) {
          // Apply winning tombstones before potential logical replacements.
          // Otherwise archive order `replacement, old-tombstone` sees the old
          // live edge, skips the replacement as a duplicate, then deletes the
          // old edge — committing a different (broken) graph from validation.
          const incomingRows = [...data[key]].sort((left, right) => {
            const leftDeleted = (left as { deleted?: boolean }).deleted === true;
            const rightDeleted = (right as { deleted?: boolean }).deleted === true;
            if (leftDeleted !== rightDeleted) return leftDeleted ? -1 : 1;
            return left.updatedAt < right.updatedAt
              ? -1
              : left.updatedAt > right.updatedAt
                ? 1
                : left.id < right.id
                  ? -1
                  : left.id > right.id
                    ? 1
                    : 0;
          });
          for (const incoming of incomingRows) {
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
                  // duplicate is skipped.  List membership ids do not share a
                  // namespace with post block ids.
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
                  skippedPostBlockTargets.set(row.id, clash.id);
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
            if (key === "blockNoteAttachments") {
              const row = incoming as unknown as {
                id: string;
                blockId: string;
                noteId: string;
                deleted?: boolean;
              };
              // Follow a skipped duplicate embed onto its retained post block.
              const retainedBlock = skippedPostBlockTargets.get(row.blockId);
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
            if (key === "places" && incoming.deleted) {
              if (incoming.updatedAt > existing.updatedAt) {
                const tombstone = {
                  ...(existing as unknown as Place),
                  deleted: true,
                  updatedAt: incoming.updatedAt,
                  refKeys: allRefKeys(existing as unknown as Place),
                };
                await db.places.put(tombstone);
                written.push({ table: "places", row: tombstone });
                imported += 1;
              }
              continue;
            }
            if (key === "places") {
              const merged = mergePlaceVersions(
                existing as unknown as Place,
                incoming as unknown as Place,
                incoming.updatedAt > existing.updatedAt,
              );
              const mergedRow = { ...merged, refKeys: allRefKeys(merged) };
              // Even an older archive may carry an append-only history entry
              // or external provenance the newer LWW row has not observed.
              // Preserve it without letting mutable/immutable fields roll back.
              if (JSON.stringify(mergedRow) !== JSON.stringify(existing)) {
                await db.places.put(mergedRow);
                written.push({ table: "places", row: mergedRow });
                imported += 1;
              }
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
                  shareable: false,
                  createdAt: now,
                  updatedAt: now,
                };
                await db.notes.put(copy);
                written.push({ table: "notes", row: copy });
                conflictCopies += 1;
              }
              continue;
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
                shareable: false,
                targetKey: noteTargetKey((existing as unknown as Note).target),
                createdAt: now,
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
