/**
 * The wire contract for published documents (spec/src/sharing.md §Published
 * documents) — Zod mirrors of the domain's PublishedPlace/PublishedList/
 * PublishedPost. A published document is self-contained and never carries
 * editor tokens or custom link protocols; the share service validates every
 * PUT body against these schemas.
 */
import { z } from "zod";

/** Document limits, enforced in the schemas and mirrored client-side. */
export const PUBLISHED_LIMITS = {
  maxPlaces: 2000,
  /** Post body cap: 256 KiB of UTF-8. */
  maxBodyBytes: 262_144,
  maxTitleChars: 300,
} as const;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export const osmRefSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.string().regex(/^\d+$/),
});

export const markerShapeSchema = z.enum([
  "circle",
  "diamond",
  "triangle",
  "square",
  "hexagon",
  "star",
  "semicircle",
  "chevron",
]);

export const listMarkerSchema = z.object({
  shape: markerShapeSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const titleSchema = z.string().min(1).max(PUBLISHED_LIMITS.maxTitleChars);
const httpsUrlSchema = z
  .string()
  .max(2000)
  .regex(/^https:\/\//);

/** Place photos are Wikimedia-hosted only (spec/src/sharing.md §Published documents). */
const wikimediaImageUrlSchema = z
  .string()
  .max(2000)
  .regex(/^https:\/\/(?:commons|upload)\.wikimedia\.org\//);

export const publishedPlaceSchema = z.object({
  id: z.string().min(1).max(100), // the PlaceId — the stable key mentions rewrite to
  name: z.string().min(1).max(400),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(600).optional(),
  category: z.string().max(120).optional(),
  osmRef: osmRefSchema.optional(), // attribution + OSM deep link on the public page
  imageUrl: wikimediaImageUrlSchema.optional(), // Wikimedia-hosted photo, when the place carries one
  // Richer POI facts (spec/src/data-model.md §Normative rules): captured from
  // OSM tags and Wikipedia summaries, published verbatim when present.
  website: httpsUrlSchema.optional(),
  phone: z.string().max(60).optional(),
  openingHours: z.string().max(300).optional(),
  cuisine: z.string().max(120).optional(),
  wheelchair: z.enum(["yes", "limited", "no"]).optional(),
  description: z.string().max(600).optional(),
  wikipediaUrl: httpsUrlSchema.optional(), // credits a Wikipedia-sourced description
});

const placesSchema = z.array(publishedPlaceSchema).max(PUBLISHED_LIMITS.maxPlaces);

export const publishedListSchema = z.object({
  v: z.literal(1),
  kind: z.literal("list"),
  title: titleSchema,
  marker: listMarkerSchema,
  places: placesSchema, // list order
  posts: z.array(z.object({ title: titleSchema, url: httpsUrlSchema })).optional(),
});

export const publishedPostSchema = z.object({
  v: z.literal(1),
  kind: z.literal("post"),
  title: titleSchema,
  body: z.string().refine((value) => utf8Bytes(value) <= PUBLISHED_LIMITS.maxBodyBytes, {
    message: `body exceeds ${PUBLISHED_LIMITS.maxBodyBytes} bytes`,
  }),
  places: placesSchema, // the post's projection at publish time
  list: z.object({ title: titleSchema, url: httpsUrlSchema.optional() }).optional(),
});

export type PublishedPlace = z.infer<typeof publishedPlaceSchema>;
export type PublishedList = z.infer<typeof publishedListSchema>;
export type PublishedPost = z.infer<typeof publishedPostSchema>;
export type PublishedDocument = PublishedList | PublishedPost;

/** Validate a document of the given kind; throws ZodError on any violation. */
export function parsePublishedDocument(kind: "list", json: unknown): PublishedList;
export function parsePublishedDocument(kind: "post", json: unknown): PublishedPost;
export function parsePublishedDocument(kind: "list" | "post", json: unknown): PublishedDocument;
export function parsePublishedDocument(kind: "list" | "post", json: unknown): PublishedDocument {
  return kind === "list" ? publishedListSchema.parse(json) : publishedPostSchema.parse(json);
}
