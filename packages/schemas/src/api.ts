/**
 * Share-service API shapes (spec/src/sharing.md §The share service). The PUT
 * body IS the published document (see ./published); reads are public;
 * mutations carry a Bearer editor token the server only ever stores as a hash.
 */
import { z } from "zod";

/** Public slugs: normalized, human-readable, never secrets. */
export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits, hyphens");

export const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "app",
  "assets",
  "help",
  "l",
  "list",
  "lists",
  "login",
  "p",
  "post",
  "posts",
  "review",
  "s",
  "settings",
  "share",
  "static",
  "www",
]);

export function normalizeSlug(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** URL path segment ↔ document kind: /s/lists/:slug carries a "list" document. */
export const PATH_KINDS = { lists: "list", posts: "post" } as const;
export type PathKind = keyof typeof PATH_KINDS;

/** PUT and DELETE respond with the slug alone — there is no revision concept. */
export const mutationResponseSchema = z.object({
  slug: slugSchema,
  revision: z.never().optional(),
});
export type MutationResponse = z.infer<typeof mutationResponseSchema>;

/** Request limits enforced by the service (and mirrored client-side). */
export const LIMITS = {
  /** Whole request body cap in bytes. */
  requestBytes: 1_048_576,
  /** Mutations per token per minute. */
  mutationsPerMinute: 30,
  /** Reads per IP per minute (service-level backstop; CDN sits in front). */
  readsPerMinute: 300,
} as const;
