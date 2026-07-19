/**
 * Public projection (book/src/sharing.md §Shared guide document): build the
 * versioned SharedGuide from a list. Private PlaceIds, database ids, tags
 * (until BlockTagSelection lands), non-shareable notes, and editor tokens
 * never enter the payload; note images become explicit text placeholders.
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
 * placeholders, in every Markdown spelling, and no asset id may survive.
 */
export function withImagePlaceholders(body: string): string {
  return body
    .replace(/!\[[^\]]*\]\(asset:[^)]*\)/g, "*[image omitted from shared page]*")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "*[image omitted from shared page]*")
    .replace(/^\[[^\]]+\]:\s*asset:.*$/gm, "")
    .replace(/asset:[\w./-]+/g, "[image omitted]");
}

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
}

export async function projectGuide(
  repo: PlacemarksRepository,
  listId: string,
): Promise<{ guide: SharedGuide; stats: ProjectionStats } | undefined> {
  const list = await repo.getList(listId);
  if (!list) return undefined;
  const blocks = await repo.getGuideBlocks(listId);

  const stats: ProjectionStats = {
    places: 0,
    sections: 0,
    sharedNotes: 0,
    omittedPlaces: 0,
    imagesOmitted: false,
  };
  const sharedBlocks: SharedBlock[] = [];

  for (const view of blocks) {
    if (view.block.content.type === "section") {
      // A section's own list note travels only when marked shareable.
      if (!view.sectionNote?.shareable) continue;
      stats.sections += 1;
      if (/asset:/.test(view.sectionNote.body)) stats.imagesOmitted = true;
      sharedBlocks.push({
        id: `b${sharedBlocks.length + 1}`,
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
    const shareableNotes = (await repo.listNotesForPlace(place.id)).filter((n) => n.shareable);
    if (shareableNotes.some((n) => /asset:/.test(n.body))) stats.imagesOmitted = true;
    stats.places += 1;
    stats.sharedNotes += shareableNotes.length;
    sharedBlocks.push({
      id: `b${sharedBlocks.length + 1}`,
      type: "place",
      place: anchor,
      ...(shareableNotes.length > 0 ? { notes: shareableNotes.map(toSharedNote) } : {}),
      // Tags stay private until explicit BlockTagSelection lands (book/src/sharing.md).
    });
  }

  // The document mirrors the book's schema exactly — the local marker colour
  // is a viewer-side concern, not part of the shared contract.
  const base = {
    v: 1 as const,
    title: list.name,
    blocks: sharedBlocks,
  };
  const guide: SharedGuide = { ...base, contentHash: await contentHash(base) };
  return { guide, stats };
}
