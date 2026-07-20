/**
 * Sync-service wire contract (spec/src/storage-sync.md §Multi-device sync):
 * idempotent mutation push, server-monotonic cursor pull, and the minimal
 * account handshake that does nothing but name a sync scope.
 */
import { z } from "zod";

/** The synced tables — private owned entities and their edges. */
export const SYNCED_TABLE_NAMES = [
  "places",
  "tags",
  "tagAssignments",
  "notes",
  "mediaAssets",
  "lists",
  "listBlocks",
  "posts",
  "postBlocks",
  "blockNoteAttachments",
  "blockTagSelections",
] as const;

export const syncMutationSchema = z.object({
  /** Globally unique — the push idempotency identity. */
  id: z.string().min(1).max(80),
  actorId: z.string().min(1).max(80),
  table: z.enum(SYNCED_TABLE_NAMES),
  entityId: z.string().min(1).max(120),
  /** Sortable hybrid-logical-clock stamp — the conflict order. */
  hlc: z.string().min(1).max(160),
  /** The complete row after the mutation (tombstones carry deleted: true). */
  row: z.record(z.string(), z.unknown()),
});

export const pushRequestSchema = z.object({
  mutations: z.array(syncMutationSchema).max(200),
});

export const pushResponseSchema = z.object({
  acked: z.array(z.string()),
});

export const remoteChangeSchema = z.object({
  seq: z.number().int().min(1),
  table: z.enum(SYNCED_TABLE_NAMES),
  entityId: z.string(),
  hlc: z.string(),
  actorId: z.string(),
  row: z.record(z.string(), z.unknown()),
});

export const pullResponseSchema = z.object({
  changes: z.array(remoteChangeSchema),
  /** Server-monotonic; hand it back on the next pull. */
  cursor: z.string(),
});

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
});

export const loginCompleteRequestSchema = z.object({
  email: z.string().email().max(320),
  code: z.string().min(4).max(12),
});

export const loginCompleteResponseSchema = z.object({
  accountId: z.string(),
  /** Bearer secret naming the sync scope; the server stores only its hash. */
  token: z.string(),
});

export type SyncMutation = z.infer<typeof syncMutationSchema>;
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type PushResponse = z.infer<typeof pushResponseSchema>;
export type RemoteChangeWire = z.infer<typeof remoteChangeSchema>;
export type PullResponse = z.infer<typeof pullResponseSchema>;

/** Push batch/row limits enforced by the service (mirrored client-side). */
export const SYNC_LIMITS = {
  /** Whole request body cap in bytes. */
  requestBytes: 2_097_152,
  /** Mutations per push request. */
  mutationsPerPush: 200,
  /** Changes per pull response. */
  changesPerPull: 500,
} as const;
