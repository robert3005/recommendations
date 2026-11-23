/**
 * Reading published documents (spec/src/sharing.md §The public viewer): the
 * viewer fetches GET /s/lists/:slug or /s/posts/:slug and renders exactly what
 * was published — no OSM resolution, no import. 404, 410, and network failure
 * are distinct, designed states, never a blank page.
 */
import {
  type PublishedList,
  type PublishedPost,
  parsePublishedDocument,
} from "@placemarks/schemas";
import { shareDocumentUrl } from "./shareUrl";

export type ViewerFailure = "gone" | "not-found" | "unreachable";

export class PublishedDocumentError extends Error {
  reason: ViewerFailure;

  constructor(reason: ViewerFailure) {
    super(reason);
    this.name = "PublishedDocumentError";
    this.reason = reason;
  }
}

// Kept in its own module so the always-mounted live publisher can build
// share URLs without pulling the document schemas (and zod) into the shell.
export { shareDocumentUrl };

async function fetchDocument(kind: "list" | "post", slug: string, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(shareDocumentUrl(kind, slug), signal ? { signal } : {});
  } catch {
    throw new PublishedDocumentError("unreachable");
  }
  if (response.status === 404) throw new PublishedDocumentError("not-found");
  if (response.status === 410) throw new PublishedDocumentError("gone");
  if (!response.ok) throw new PublishedDocumentError("unreachable");
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new PublishedDocumentError("unreachable");
  }
  try {
    return parsePublishedDocument(kind, json);
  } catch {
    // A document this app cannot parse is as unusable as an absent one.
    throw new PublishedDocumentError("unreachable");
  }
}

export async function fetchPublishedList(slug: string, signal?: AbortSignal) {
  return (await fetchDocument("list", slug, signal)) as PublishedList;
}

export async function fetchPublishedPost(slug: string, signal?: AbortSignal) {
  return (await fetchDocument("post", slug, signal)) as PublishedPost;
}
