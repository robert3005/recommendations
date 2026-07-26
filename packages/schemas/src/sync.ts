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

const idSchema = z.string().min(1).max(120);
const actorIdSchema = z.string().min(1).max(80);
const timestampSchema = z.string().min(1).max(80);
const baseEntityShape = {
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deleted: z.boolean().optional(),
};

const osmRefSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.string().min(1).max(80),
});

const coordinatesShape = {
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
};

const evidenceSchema = z.object({
  ref: osmRefSchema,
  osmVersion: z.number().int().nonnegative().optional(),
  source: z.literal("OpenStreetMap"),
  license: z.literal("ODbL-1.0"),
  attribution: z.literal("© OpenStreetMap contributors"),
  name: z.string().optional(),
  category: z.string(),
  ...coordinatesShape,
  address: z.string().optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  openingHours: z.string().optional(),
  identityTags: z.record(z.string(), z.string()),
  observedAt: timestampSchema,
});

const noteTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("place"), placeId: idSchema }),
  z.object({ kind: z.literal("post"), postId: idSchema }),
]);

const placeSchema = z
  .object({
    ...baseEntityShape,
    origin: z.enum(["osm", "manual", "import"]),
    currentOsmRef: osmRefSchema.optional(),
    currentOsmLinkedAt: timestampSchema.optional(),
    osmRefHistory: z.array(
      z.object({
        ref: osmRefSchema,
        linkedAt: timestampSchema,
        unlinkedAt: timestampSchema.optional(),
        reason: z.enum(["replaced", "merged", "owner-confirmed", "resolver-match"]).optional(),
      }),
    ),
    firstSeen: evidenceSchema.optional(),
    lastVerified: evidenceSchema.optional(),
    manual: z
      .object({
        name: z.string(),
        ...coordinatesShape,
        category: z.string().optional(),
        address: z.string().optional(),
        website: z.string().optional(),
        phone: z.string().optional(),
        openingHours: z.string().optional(),
      })
      .optional(),
    externalRefs: z
      .array(
        z.object({
          provider: z.enum(["google-maps", "web"]),
          url: z.string(),
          fid: z.string().optional(),
          importedAt: timestampSchema,
        }),
      )
      .optional(),
    resolutionState: z.enum([
      "resolved",
      "stale",
      "unavailable",
      "missing",
      "needs-review",
      "unlinked",
    ]),
    lastResolutionAttemptAt: timestampSchema.optional(),
    // Local-only derived index. Receivers recompute it before writing.
    refKeys: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((place, context) => {
    if (place.osmRefHistory.some((entry) => entry.unlinkedAt === undefined)) {
      context.addIssue({
        code: "custom",
        message: "OSM history contains only completed link intervals",
        path: ["osmRefHistory"],
      });
    }
    if (place.currentOsmRef) {
      if (!place.currentOsmLinkedAt || !place.firstSeen || !place.lastVerified) {
        context.addIssue({
          code: "custom",
          message: "an OSM-linked place requires link time and recovery evidence",
          path: ["currentOsmRef"],
        });
      }
      if (
        place.lastVerified &&
        (place.lastVerified.ref.type !== place.currentOsmRef.type ||
          place.lastVerified.ref.id !== place.currentOsmRef.id)
      ) {
        context.addIssue({
          code: "custom",
          message: "lastVerified evidence must describe the current OSM element",
          path: ["lastVerified", "ref"],
        });
      }
      if (place.resolutionState === "unlinked") {
        context.addIssue({
          code: "custom",
          message: "an OSM-linked place cannot have unlinked resolution state",
          path: ["resolutionState"],
        });
      }
    } else {
      if (!place.manual) {
        context.addIssue({
          code: "custom",
          message: "an unlinked place requires manual display facts",
          path: ["manual"],
        });
      }
      if (place.origin === "osm" || place.resolutionState !== "unlinked") {
        context.addIssue({
          code: "custom",
          message: "a place without an OSM binding must be an unlinked manual/import place",
          path: ["resolutionState"],
        });
      }
    }
  });

const tagSchema = z
  .object({
    ...baseEntityShape,
    name: z.string(),
    nameNorm: z.string(),
    color: z.string().optional(),
  })
  .strict();

const tagAssignmentSchema = z
  .object({
    ...baseEntityShape,
    placeId: idSchema,
    tagId: idSchema,
  })
  .strict();

const noteSchema = z
  .object({
    ...baseEntityShape,
    target: noteTargetSchema,
    title: z.string().optional(),
    body: z.string(),
    mediaIds: z.array(idSchema),
    shareable: z.boolean(),
    // Local-only derived index. Receivers recompute it before writing.
    targetKey: z.string().optional(),
  })
  .strict();

const mediaAssetSchema = z
  .object({
    ...baseEntityShape,
    mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    localBlobKey: idSchema,
    hostedMediaId: z.string().optional(),
  })
  .strict();

const listSchema = z
  .object({
    ...baseEntityShape,
    name: z.string(),
    marker: z.object({ color: z.string().min(1), icon: z.string().min(1) }),
    coverMediaId: idSchema.optional(),
    // v7 migration cleared these legacy fields with undefined values.
    color: z.string().optional(),
    icon: z.string().optional(),
  })
  .strict();

const listBlockContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("place"), placeId: idSchema }),
  // v7 left tombstoned pre-pivot section rows behind. They still need to be
  // accepted during the one-time bootstrap, but may never be live.
  z.object({ type: z.literal("section"), noteId: idSchema }),
]);

const listBlockSchema = z
  .object({
    ...baseEntityShape,
    listId: idSchema,
    rank: z.string().min(1),
    content: listBlockContentSchema,
    kind: z.enum(["place", "section"]).optional(),
    refId: idSchema.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.deleted !== true && row.content.type !== "place") {
      context.addIssue({
        code: "custom",
        message: "live list blocks carry place membership only",
        path: ["content"],
      });
    }
  });

const postSchema = z
  .object({
    ...baseEntityShape,
    title: z.string(),
    listId: idSchema,
    coverMediaId: idSchema.optional(),
  })
  .strict();

const postBlockSchema = z
  .object({
    ...baseEntityShape,
    postId: idSchema,
    rank: z.string().min(1),
    content: z.discriminatedUnion("type", [
      z.object({ type: z.literal("section"), noteId: idSchema }),
      z.object({ type: z.literal("place"), placeId: idSchema }),
    ]),
    kind: z.enum(["place", "section"]).optional(),
    refId: idSchema.optional(),
  })
  .strict();

const blockNoteAttachmentSchema = z
  .object({
    ...baseEntityShape,
    blockId: idSchema,
    noteId: idSchema,
    rank: z.string().min(1),
  })
  .strict();

const blockTagSelectionSchema = z
  .object({
    ...baseEntityShape,
    blockId: idSchema,
    tagId: idSchema,
  })
  .strict();

/** Complete domain validation for every full-row sync snapshot. */
export const syncEntityRowSchemas = {
  places: placeSchema,
  tags: tagSchema,
  tagAssignments: tagAssignmentSchema,
  notes: noteSchema,
  mediaAssets: mediaAssetSchema,
  lists: listSchema,
  listBlocks: listBlockSchema,
  posts: postSchema,
  postBlocks: postBlockSchema,
  blockNoteAttachments: blockNoteAttachmentSchema,
  blockTagSelections: blockTagSelectionSchema,
} as const;

const hlcSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^\d{15}:[0-9a-f]{6}:.+$/, "invalid hybrid logical clock")
  .refine(
    (value) => value !== "999999999999999:ffffff:" && !value.startsWith("999999999999999:ffffff:"),
    "hybrid logical clock has no representable successor",
  );

/** Actor keys/counters are bounded; the HTTP request-size cap bounds total payload. */
export const syncVersionVectorSchema = z.record(
  actorIdSchema,
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
);

function validateEnvelopeRow(
  value: {
    table: (typeof SYNCED_TABLE_NAMES)[number];
    entityId: string;
    actorId: string;
    hlc: string;
    version?: Record<string, number>;
    row: Record<string, unknown>;
  },
  context: z.RefinementCtx,
): void {
  const parsed = syncEntityRowSchemas[value.table].safeParse(value.row);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: ["row", ...issue.path],
      });
    }
    return;
  }
  if (parsed.data.id !== value.entityId) {
    context.addIssue({
      code: "custom",
      message: "row id must match entityId",
      path: ["row", "id"],
    });
  }
  if (!value.hlc.endsWith(`:${value.actorId}`)) {
    context.addIssue({
      code: "custom",
      message: "HLC actor must match actorId",
      path: ["hlc"],
    });
  }
}

export const syncMutationSchema = z
  .object({
    /** Globally unique — the push idempotency identity. */
    id: z.string().min(1).max(80),
    actorId: actorIdSchema,
    table: z.enum(SYNCED_TABLE_NAMES),
    entityId: idSchema,
    /** Sortable hybrid-logical-clock stamp — the conflict order. */
    hlc: hlcSchema,
    /** Optional only for records accepted before causal vectors shipped. */
    version: syncVersionVectorSchema.optional(),
    /** The complete row after the mutation (tombstones carry deleted: true). */
    row: z.record(z.string(), z.unknown()),
  })
  .superRefine(validateEnvelopeRow);

export const pushRequestSchema = z.object({
  mutations: z.array(syncMutationSchema).max(200),
});

export const pushResponseSchema = z.object({
  acked: z.array(z.string()),
});

export const remoteChangeSchema = z
  .object({
    seq: z.number().int().min(1),
    table: z.enum(SYNCED_TABLE_NAMES),
    entityId: idSchema,
    hlc: hlcSchema,
    actorId: actorIdSchema,
    version: syncVersionVectorSchema.optional(),
    row: z.record(z.string(), z.unknown()),
  })
  .superRefine(validateEnvelopeRow);

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
  /** Email/code request body cap in bytes. */
  loginRequestBytes: 4_096,
  /** Whole request body cap in bytes. */
  requestBytes: 2_097_152,
  /** Whole pull response body cap in bytes. */
  pullResponseBytes: 2_097_152,
  /** Mutations per push request. */
  mutationsPerPush: 200,
  /** Changes per pull response. */
  changesPerPull: 500,
} as const;
