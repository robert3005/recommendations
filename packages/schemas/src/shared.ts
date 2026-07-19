/**
 * The versioned wire contract for shared documents (book/src/sharing.md
 * §Shared guide document, book/src/notes.md §Publishing a note page). Both
 * sharing modes and the share service validate against these schemas — the
 * document never carries private PlaceIds, database ids, or editor tokens.
 */
import { z } from "zod";

export const osmElementRefSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.string().regex(/^\d+$/),
});

export const sharedPlaceEvidenceSchema = z.object({
  osmRef: osmElementRefSchema,
  osmVersion: z.number().int().optional(),
  source: z.literal("OpenStreetMap"),
  license: z.literal("ODbL-1.0"),
  attribution: z.literal("© OpenStreetMap contributors"),
  name: z.string().max(400).optional(),
  category: z.string().max(100),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(600).optional(),
  website: z.string().max(2000).optional(),
  phone: z.string().max(100).optional(),
  /** Bounded wikidata/brand/ref identifiers for recovery. */
  stableIds: z.record(z.string().max(100), z.string().max(400)).optional(),
  observedAt: z.string(),
});

export const sharedPlaceAnchorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("osm"),
    currentOsmRef: osmElementRefSchema,
    firstSeen: sharedPlaceEvidenceSchema,
    lastVerified: sharedPlaceEvidenceSchema,
  }),
  z.object({
    kind: z.literal("manual"), // an unlinked pin: owner-provided facts, no OSM claim
    name: z.string().min(1).max(400),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    category: z.string().max(100).optional(),
  }),
]);

export const sharedNoteBodySchema = z.object({
  pageSlug: z.string().max(120).optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(65_536),
  media: z
    .array(z.object({ hostedMediaId: z.string().max(120) }))
    .max(20)
    .optional(),
});

export const sharedBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().max(60),
    type: z.literal("section"),
    note: sharedNoteBodySchema,
  }),
  z.object({
    id: z.string().max(60),
    type: z.literal("place"),
    place: sharedPlaceAnchorSchema,
    notes: z.array(sharedNoteBodySchema).max(20).optional(),
    tags: z.array(z.string().max(60)).max(30).optional(),
  }),
]);

export const sharedGuideSchema = z.object({
  v: z.literal(1),
  slug: z.string().max(120).optional(), // hosted mode only
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  cover: z.object({ hostedMediaId: z.string().max(120) }).optional(),
  blocks: z.array(sharedBlockSchema).max(500),
  contentHash: z.string().max(80),
  publishedAt: z.string().optional(),
});

export const sharedNoteContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("place"), place: sharedPlaceAnchorSchema }),
  z.object({ kind: z.literal("list"), listTitle: z.string().max(300) }),
]);

export const sharedNoteSchema = z.object({
  v: z.literal(1),
  slug: z.string().max(120),
  title: z.string().max(300).optional(),
  context: sharedNoteContextSchema,
  body: z.string().max(65_536),
  media: z.array(z.object({ hostedMediaId: z.string().max(120) })).max(20),
  contentHash: z.string().max(80),
  publishedAt: z.string(),
});

export type SharedPlaceEvidence = z.infer<typeof sharedPlaceEvidenceSchema>;
export type SharedPlaceAnchor = z.infer<typeof sharedPlaceAnchorSchema>;
export type SharedNoteBody = z.infer<typeof sharedNoteBodySchema>;
export type SharedBlock = z.infer<typeof sharedBlockSchema>;
export type SharedGuide = z.infer<typeof sharedGuideSchema>;
export type SharedNote = z.infer<typeof sharedNoteSchema>;

/** Public slugs: normalized, human-readable, never secrets. */
export const slugSchema = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits, hyphens");

export const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "app",
  "assets",
  "help",
  "l",
  "lists",
  "login",
  "n",
  "notes",
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
