/**
 * Public projection (spec/src/sharing.md §One block document, two
 * projections): build the versioned block document from a list (place blocks
 * only; shareable place notes ride along) or from a post (the full
 * section/embed sequence with explicit note attachments and tag selections,
 * plus a reference to its list). Private PlaceIds, database ids, non-selected
 * tags, non-shareable notes, and editor tokens never enter the payload; note
 * images become explicit text placeholders.
 */
import type { Note, OsmEvidence, Place, PlacemarksRepository } from "@placemarks/domain";
import type {
  SharedBlock,
  SharedGuide,
  SharedNoteBody,
  SharedPlaceAnchor,
  SharedPlaceEvidence,
} from "@placemarks/schemas";

/** Bounded identity ids worth carrying for recovery. */
function stableIds(tags: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (
      key === "wikidata" ||
      key === "brand" ||
      key === "brand:wikidata" ||
      key.startsWith("ref:")
    ) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toSharedEvidence(evidence: OsmEvidence): SharedPlaceEvidence {
  return {
    osmRef: evidence.ref,
    ...(evidence.osmVersion !== undefined ? { osmVersion: evidence.osmVersion } : {}),
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    ...(evidence.name ? { name: evidence.name } : {}),
    category: evidence.category,
    lat: evidence.lat,
    lng: evidence.lng,
    ...(evidence.address ? { address: evidence.address } : {}),
    ...(evidence.website ? { website: evidence.website } : {}),
    ...(evidence.phone ? { phone: evidence.phone } : {}),
    ...(stableIds(evidence.identityTags) ? { stableIds: stableIds(evidence.identityTags) } : {}),
    observedAt: evidence.observedAt,
  };
}

export function anchorForPlace(place: Place): SharedPlaceAnchor | undefined {
  if (place.currentOsmRef && place.firstSeen && place.lastVerified) {
    return {
      kind: "osm",
      currentOsmRef: place.currentOsmRef,
      firstSeen: toSharedEvidence(place.firstSeen),
      lastVerified: toSharedEvidence(place.lastVerified),
    };
  }
  if (place.manual) {
    return {
      kind: "manual",
      name: place.manual.name,
      lat: place.manual.lat,
      lng: place.manual.lng,
      ...(place.manual.category ? { category: place.manual.category } : {}),
    };
  }
  return undefined;
}

/**
 * Snapshot links cannot hold a durable media lease — images become
 * placeholders, in every Markdown spelling, and no asset id or private remote
 * destination may survive in the payload.
 */
export function withImagePlaceholders(body: string): string {
  // Labels used by reference-style images — their definition lines carry the
  // destination and must not survive in the payload.
  const imageLabels = new Set<string>();
  for (const match of body.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    imageLabels.add((match[2] || match[1] || "").toLowerCase());
  }
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "*[image omitted from shared page]*")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "*[image omitted from shared page]*")
    .replace(/^\[([^\]]+)\]:\s*(.*)$/gm, (line, label: string, destination: string) =>
      imageLabels.has(label.toLowerCase()) || /^asset:/.test(destination.trim()) ? "" : line,
    )
    .replace(/asset:[\w./-]+/g, "[image omitted]");
}

/** The human-readable identity of every image a body would omit. */
export function omittedImageAlts(body: string): string[] {
  const alts: string[] = [];
  for (const match of body.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)) {
    alts.push(match[1] || "unnamed image");
  }
  for (const match of body.matchAll(/!\[([^\]]*)\]\[[^\]]*\]/g)) {
    alts.push(match[1] || "unnamed image");
  }
  return alts;
}

const containsImages = (body: string): boolean =>
  /!\[[^\]]*\](\([^)]*\)|\[[^\]]*\])/.test(body) || /asset:/.test(body);

function toSharedNote(note: Note): SharedNoteBody {
  return {
    ...(note.title ? { title: note.title } : {}),
    body: withImagePlaceholders(note.body),
  };
}

export async function contentHash(subject: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(subject));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProjectionStats {
  places: number;
  sections: number;
  sharedNotes: number;
  /** Place blocks that could not be projected (no anchor) — surfaced, never silent. */
  omittedPlaces: number;
  imagesOmitted: boolean;
  /** Each omitted image, by its alt text — disclosure is per image, not a boolean. */
  omittedImages?: string[];
}

function newStats(): ProjectionStats {
  return {
    places: 0,
    sections: 0,
    sharedNotes: 0,
    omittedPlaces: 0,
    imagesOmitted: false,
    omittedImages: [],
  };
}

// A block's public identity derives from (but never leaks) its private id —
// stable across reorders, opaque to readers.
const publicBlockId = async (privateId: string): Promise<string> =>
  `b${(await contentHash(`block:${privateId}`)).slice(0, 16)}`;

/**
 * A shared **list** projects the list's place blocks — no narrative sections;
 * each place's shareable notes ride along (spec/src/sharing.md §First-release
 * simplifications). Title = list name.
 */
export async function projectList(
  repo: PlacemarksRepository,
  listId: string,
): Promise<{ guide: SharedGuide; stats: ProjectionStats } | undefined> {
  const list = await repo.getList(listId);
  if (!list) return undefined;
  const blocks = await repo.getListBlocks(listId);

  const stats = newStats();
  const noteImages = (body: string) => {
    if (!containsImages(body)) return;
    stats.imagesOmitted = true;
    stats.omittedImages?.push(...omittedImageAlts(body));
  };
  const sharedBlocks: SharedBlock[] = [];

  for (const view of blocks) {
    const anchor = anchorForPlace(view.place);
    if (!anchor) {
      stats.omittedPlaces += 1;
      continue;
    }
    const shareableNotes = (await repo.listNotesForPlace(view.place.id)).filter((n) => n.shareable);
    for (const shared of shareableNotes) noteImages(shared.body);
    stats.places += 1;
    stats.sharedNotes += shareableNotes.length;
    sharedBlocks.push({
      id: await publicBlockId(view.block.id),
      type: "place",
      place: anchor,
      ...(shareableNotes.length > 0 ? { notes: shareableNotes.map(toSharedNote) } : {}),
    });
  }

  // The document mirrors the spec's schema exactly — the local marker is a
  // viewer-side concern, not part of the shared contract.
  const base = {
    v: 1 as const,
    kind: "list" as const,
    title: list.name,
    blocks: sharedBlocks,
  };
  const guide: SharedGuide = { ...base, contentHash: await contentHash(base) };
  return { guide, stats };
}

/**
 * A shared **post** projects the post's full block sequence — prose sections
 * (each section's own shareable post note), place embeds with explicitly
 * attached shareable notes and selected tags — plus a reference to its list:
 * the list's title always, its public slug when the caller resolved one
 * (spec/src/posts.md §Publishing).
 */
export async function projectPost(
  repo: PlacemarksRepository,
  postId: string,
  listSlug?: string,
): Promise<{ guide: SharedGuide; stats: ProjectionStats } | undefined> {
  const post = await repo.getPost(postId);
  if (!post) return undefined;
  const list = await repo.getList(post.listId);
  if (!list) return undefined;
  const blocks = await repo.getPostBlocks(postId);

  const stats = newStats();
  const noteImages = (body: string) => {
    if (!containsImages(body)) return;
    stats.imagesOmitted = true;
    stats.omittedImages?.push(...omittedImageAlts(body));
  };
  const sharedBlocks: SharedBlock[] = [];

  for (const view of blocks) {
    if (view.block.content.type === "section") {
      // A section's own post note travels only when marked shareable.
      if (!view.sectionNote?.shareable) continue;
      stats.sections += 1;
      noteImages(view.sectionNote.body);
      sharedBlocks.push({
        id: await publicBlockId(view.block.id),
        type: "section",
        note: toSharedNote(view.sectionNote),
      });
      continue;
    }
    const place = view.place;
    const anchor = place ? anchorForPlace(place) : undefined;
    if (!place || !anchor) {
      stats.omittedPlaces += 1;
      continue;
    }
    // Posts carry explicitly attached notes and selected tags — the durable
    // edges, not everything shareable on the place.
    const attachedNotes = (view.attachments ?? []).map((a) => a.note).filter((n) => n.shareable);
    for (const shared of attachedNotes) noteImages(shared.body);
    const selectedTags = (view.tagSelections ?? []).map((s) => s.tag.name);
    stats.places += 1;
    stats.sharedNotes += attachedNotes.length;
    sharedBlocks.push({
      id: await publicBlockId(view.block.id),
      type: "place",
      place: anchor,
      ...(attachedNotes.length > 0 ? { notes: attachedNotes.map(toSharedNote) } : {}),
      ...(selectedTags.length > 0 ? { tags: selectedTags } : {}),
    });
  }

  const base = {
    v: 1 as const,
    kind: "post" as const,
    title: post.title,
    list: { title: list.name, ...(listSlug ? { slug: listSlug } : {}) },
    blocks: sharedBlocks,
  };
  const guide: SharedGuide = { ...base, contentHash: await contentHash(base) };
  return { guide, stats };
}
