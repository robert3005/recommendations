/**
 * Share-service request/response DTOs (spec/src/sharing.md §Share service).
 * Reads are public; mutations carry a Bearer editor token the server only ever
 * stores as a hash.
 */
import { z } from "zod";
import { sharedGuideSchema, sharedNoteSchema, slugSchema } from "./shared";

export const createGuideRequestSchema = z.object({
  desiredSlug: slugSchema,
  document: sharedGuideSchema,
});

export const putGuideRequestSchema = z.object({
  document: sharedGuideSchema,
});

export const createNoteRequestSchema = z.object({
  desiredSlug: slugSchema,
  document: sharedNoteSchema,
});

export const putNoteRequestSchema = z.object({
  document: sharedNoteSchema,
});

export const mutationResponseSchema = z.object({
  slug: slugSchema,
  revision: z.number().int().min(1),
});

export type CreateGuideRequest = z.infer<typeof createGuideRequestSchema>;
export type PutGuideRequest = z.infer<typeof putGuideRequestSchema>;
export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;
export type PutNoteRequest = z.infer<typeof putNoteRequestSchema>;
export type MutationResponse = z.infer<typeof mutationResponseSchema>;

/** Request/document limits enforced by the service (and mirrored client-side). */
export const LIMITS = {
  /** Whole request body cap in bytes. */
  requestBytes: 1_048_576,
  /** Serialized SharedGuide/SharedNote cap in bytes. */
  documentBytes: 786_432,
  /** Mutations per token per minute. */
  mutationsPerMinute: 30,
  /** Reads per IP per minute (service-level backstop; CDN sits in front). */
  readsPerMinute: 300,
} as const;
