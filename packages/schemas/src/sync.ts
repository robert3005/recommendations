/**
 * The sync wire contract (spec/src/sync.md §The service): a library is a bag
 * of opaque rows. The server never sees a place, a list or a note — each row
 * is a key the device derived (an HMAC, so it reveals neither table nor id)
 * and a ciphertext only the library's devices can open. The server's one job
 * beyond storage is ordering: every write gets the library's next sequence
 * number, and devices ask for "everything after N".
 */
import { z } from "zod";

/** Limits enforced by the service and mirrored by the client's batching. */
export const SYNC_LIMITS = {
  /** Rows per push. */
  rowsPerPush: 200,
  /** One row's ciphertext, base64 characters (~96 KiB of plaintext). */
  cipherChars: 131_072,
  /** Whole push body, bytes. */
  requestBytes: 4_194_304,
  /** Rows returned per pull. */
  rowsPerPull: 500,
  /** Rows one library may hold (places, lists, entries, posts, views, deletion markers). */
  rowsPerLibrary: 100_000,
  /** Requests per (library, source) per minute. */
  requestsPerMinute: 120,
} as const;

/** 128 bits, hex — derived from the library key; public but unguessable. */
export const libraryIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** HMAC-SHA-256 of "<table>:<id>" under the library's row-key, hex. */
export const rowKeySchema = z.string().regex(/^[0-9a-f]{64}$/);

export const syncRowSchema = z.object({
  k: rowKeySchema,
  /** base64(iv ‖ AES-GCM ciphertext). */
  c: z
    .string()
    .min(24)
    .max(SYNC_LIMITS.cipherChars)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type SyncRow = z.infer<typeof syncRowSchema>;

export const syncPushSchema = z.object({
  rows: z.array(syncRowSchema).min(1).max(SYNC_LIMITS.rowsPerPush),
});
export type SyncPush = z.infer<typeof syncPushSchema>;

/** A stored row as a pull returns it: the same pair plus its sequence number. */
export const syncChangeSchema = syncRowSchema.extend({ seq: z.number().int().positive() });
export type SyncChange = z.infer<typeof syncChangeSchema>;

export const syncPullResponseSchema = z.object({
  rows: z.array(syncChangeSchema),
  /** The highest sequence number in this response, or the caller's `since` when empty. */
  cursor: z.number().int().min(0),
  /** More rows remain after `cursor` — pull again. */
  more: z.boolean(),
});
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

export const syncPushResponseSchema = z.object({ cursor: z.number().int().min(0) });
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;
