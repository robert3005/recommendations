/**
 * Publish projections (spec/src/sharing.md §Published documents): a published
 * document is self-contained — it embeds every fact the public page needs,
 * keyed by PlaceId so mentions rewrite to stable fragments. Hashing the
 * projection (SHA-256 of `stableStringify`, via crypto.subtle) lives in the
 * app; this module stays platform-free.
 */
import type { List, ListMarker, OsmRef, Place, Post } from "./entities";
import { rewriteBodyForPublish } from "./postLinks";

export interface PublishedPlace {
  id: string; // the PlaceId — the stable key mentions rewrite to
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  osmRef?: OsmRef; // attribution + OSM deep link on the public page
  imageUrl?: string; // Wikimedia-hosted photo, when the place carries one
  // Richer POI facts, published verbatim when the place carries them.
  // descriptionSource stays local: the public page credits Wikipedia through
  // wikipediaUrl, which is present exactly when the description came from there.
  website?: string;
  phone?: string;
  openingHours?: string;
  cuisine?: string;
  wheelchair?: string;
  description?: string;
  wikipediaUrl?: string;
}

export interface PublishedList {
  v: 1;
  kind: "list";
  title: string;
  marker: ListMarker;
  places: PublishedPlace[]; // list order
  posts?: { title: string; url: string }[]; // published posts about this list
}

export interface PublishedPost {
  v: 1;
  kind: "post";
  title: string;
  body: string; // Markdown, links rewritten at publish
  places: PublishedPlace[]; // the post's projection at publish time
  list?: { title: string; url?: string }; // list posts only; url when the list is published
}

export function toPublishedPlace(p: Place): PublishedPlace {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    ...(p.address !== undefined ? { address: p.address } : {}),
    ...(p.category !== undefined ? { category: p.category } : {}),
    ...(p.osmRef !== undefined ? { osmRef: p.osmRef } : {}),
    ...(p.imageUrl !== undefined ? { imageUrl: p.imageUrl } : {}),
    ...(p.website !== undefined ? { website: p.website } : {}),
    ...(p.phone !== undefined ? { phone: p.phone } : {}),
    ...(p.openingHours !== undefined ? { openingHours: p.openingHours } : {}),
    ...(p.cuisine !== undefined ? { cuisine: p.cuisine } : {}),
    ...(p.wheelchair !== undefined ? { wheelchair: p.wheelchair } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.wikipediaUrl !== undefined ? { wikipediaUrl: p.wikipediaUrl } : {}),
  };
}

/** `places` in list order; `posts` are the published posts about this list. */
export function projectList(
  list: List,
  places: Place[],
  publishedPosts: { title: string; url: string }[],
): PublishedList {
  return {
    v: 1,
    kind: "list",
    title: list.name,
    marker: list.marker,
    places: places.map(toPublishedPlace),
    ...(publishedPosts.length > 0 ? { posts: publishedPosts } : {}),
  };
}

/**
 * `places` is the post's projection (its list's members, or its one place);
 * the body is rewritten so no custom protocol survives publishing.
 */
export function projectPost(
  post: Post,
  places: Place[],
  opts: { listRef?: { title: string; url?: string }; postUrls: ReadonlyMap<string, string> },
): PublishedPost {
  const placeIdsInDoc: ReadonlySet<string> = new Set(places.map((p) => p.id));
  return {
    v: 1,
    kind: "post",
    title: post.title,
    body: rewriteBodyForPublish(post.body, { placeIdsInDoc, postUrls: opts.postUrls }),
    places: places.map(toPublishedPlace),
    ...(opts.listRef !== undefined ? { list: opts.listRef } : {}),
  };
}

/**
 * Deterministic serialization — sorted keys at every depth. This string is the
 * hash input for `lastPublishedHash`; "unpublished changes" is a comparison of
 * hashes, so the serialization must never depend on key insertion order.
 */
export function stableStringify(doc: unknown): string {
  return JSON.stringify(sortKeys(doc));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
    return out;
  }
  return value;
}
