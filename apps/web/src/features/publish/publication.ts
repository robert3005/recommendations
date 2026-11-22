/**
 * Publishing (spec/src/sharing.md). The first Publish and every Unpublish are
 * foreground actions the owner presses — awaited network calls that visibly
 * succeed or fail. After that a page is LIVE by default: changes to its
 * source republish on their own, each as the next version (§Live pages); a
 * page switched to manual waits for Publish update. No outbox: a live update
 * that fails is simply still behind, and is tried again on the next change
 * or when the network returns.
 *
 * The published document is the domain projection of repository reads; its
 * SHA-256 (of `stableStringify`) becomes `lastPublishedHash`, and "unpublished
 * changes" is a comparison of that hash with the current projection's.
 */
import {
  extractPostLinkIds,
  type List,
  type ListEntry,
  type Place,
  type Post,
  type PostTarget,
  type Publication,
  type PublishedList,
  type PublishedPost,
  projectList,
  projectPost,
  slugCandidates,
  slugFromTitle,
  stableStringify,
} from "@placemarks/domain";
import { SHARE_API_URL } from "../../config";
import { nowIso } from "../../lib/time";
import { shareDocumentUrl } from "../share/publishedDoc";

/**
 * The slice of the LocalRepository contract (src/data/repo.ts) that publishing
 * reads and writes. Structural, so tests can run against a seeded stub.
 */
export interface PublishRepo {
  getList(id: string): Promise<List | undefined>;
  entriesOf(listId: string): Promise<{ entry: ListEntry; place: Place }[]>;
  getPlace(id: string): Promise<Place | undefined>;
  getPost(id: string): Promise<Post | undefined>;
  postsFor(target: PostTarget): Promise<Post[]>;
  publicationFor(target: Publication["target"]): Promise<Publication | undefined>;
  createPublication(
    target: Publication["target"],
    slug: string,
    editorToken: string,
    now: string,
  ): Promise<Publication>;
  recordPublished(
    id: string,
    lastPublishedHash: string,
    now: string,
    version?: number,
  ): Promise<void>;
  markRevoked(id: string, now: string): Promise<void>;
  livePublications(): Promise<Publication[]>;
  /** The curator's display name lives in settings; optional so stubs may omit it. */
  getSetting?<T>(key: string): Promise<T | undefined>;
}

/** Settings key of the name shown on shared pages ("Curated by …"). */
export const AUTHOR_NAME_KEY = "profile.name";

/** A publish/unpublish failure with a message fit for the controls to show. */
export class PublishError extends Error {}

/**
 * The row publish controls act on: whichever of the live query's row and the
 * last foreground action's result is newer.
 */
export function fresher(
  a: Publication | undefined,
  b: Publication | undefined,
): Publication | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.updatedAt >= b.updatedAt ? a : b;
}

export interface PublishOptions {
  fetcher?: typeof fetch;
  now?: string;
}

/** ≥256 random bits, base64url — the per-publication editor secret. */
export function newEditorToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash "unpublished changes" compares (spec/src/sharing.md §Explicit publish). */
export async function documentHash(doc: PublishedList | PublishedPost): Promise<string> {
  return sha256Hex(stableStringify(doc));
}

export function publicPath(kind: "list" | "post", slug: string): string {
  return `/${kind === "list" ? "l" : "p"}/${slug}`;
}

/**
 * Published URLs are canonical https (the wire schema requires it, and the
 * service only ever lives behind TLS) even when a dev server runs over http.
 */
function httpsOrigin(): string {
  const origin = window.location.origin;
  return origin.startsWith("http://") ? origin.replace(/^http:/, "https:") : origin;
}

export function publicUrl(kind: "list" | "post", slug: string): string {
  return `${httpsOrigin()}${publicPath(kind, slug)}`;
}

function isLive(p: Publication | undefined): p is Publication {
  return p !== undefined && !p.revokedAt;
}

/** On the wire: at least one PUT succeeded for this publication. */
function onWire(p: Publication): boolean {
  return p.lastPublishedHash !== undefined;
}

/**
 * Publishing needs the network and a transport the Bearer token may cross:
 * an absolute non-localhost http: share URL never sees the editor token.
 */
function ensureReady(): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new PublishError("You are offline — publishing needs the network.");
  }
  if (!SHARE_API_URL) return; // same-origin relative path
  try {
    const url = new URL(SHARE_API_URL, "https://placeholder.invalid");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new PublishError(
        "The share service URL is not HTTPS — refusing to send the editor token.",
      );
    }
  } catch (err) {
    if (err instanceof PublishError) throw err;
    // Unparsable configuration fails at fetch time with its own error.
  }
}

// ---------- documents ----------

/** postId → public URL, for every live post publication that is on the wire. */
async function publishedPostUrls(repo: PublishRepo): Promise<Map<string, string>> {
  const live = await repo.livePublications();
  const urls = new Map<string, string>();
  for (const p of live) {
    if (p.target.kind === "post" && onWire(p)) urls.set(p.target.id, publicUrl("post", p.slug));
  }
  return urls;
}

/** The list's projection right now — places in list order, published posts linked. */
export async function buildListDocument(
  repo: PublishRepo,
  listId: string,
): Promise<PublishedList | undefined> {
  const list = await repo.getList(listId);
  if (!list) return undefined;
  const entries = await repo.entriesOf(listId);
  const posts = await repo.postsFor({ kind: "list", listId });
  const urls = await publishedPostUrls(repo);
  const publishedPosts = posts
    .filter((post) => urls.has(post.id))
    .map((post) => ({ title: post.title, url: urls.get(post.id) as string }));
  const author = (await repo.getSetting?.<string>(AUTHOR_NAME_KEY))?.trim();
  return projectList(
    list,
    entries.map((e) => e.place),
    publishedPosts,
    author ? { author } : undefined,
  );
}

/**
 * The post's projection right now: its target's places, the body rewritten so
 * no custom protocol survives, and — for list posts — the list named, linked
 * when the list has a live public page.
 */
export async function buildPostDocument(
  repo: PublishRepo,
  postId: string,
): Promise<PublishedPost | undefined> {
  const post = await repo.getPost(postId);
  if (!post) return undefined;
  let places: Place[] = [];
  let listRef: { title: string; url?: string } | undefined;
  if (post.target.kind === "list") {
    const list = await repo.getList(post.target.listId);
    if (!list) return undefined;
    places = (await repo.entriesOf(list.id)).map((e) => e.place);
    const listPublication = await repo.publicationFor({ kind: "list", id: list.id });
    listRef =
      isLive(listPublication) && onWire(listPublication)
        ? { title: list.name, url: publicUrl("list", listPublication.slug) }
        : { title: list.name };
  } else {
    const place = await repo.getPlace(post.target.placeId);
    if (place) places = [place];
  }
  return projectPost(post, places, {
    ...(listRef !== undefined ? { listRef } : {}),
    postUrls: await publishedPostUrls(repo),
  });
}

/** The hash the target projects to right now — the "unpublished changes" side. */
export async function currentDocumentHash(
  repo: PublishRepo,
  target: Publication["target"],
): Promise<string | undefined> {
  const doc =
    target.kind === "list"
      ? await buildListDocument(repo, target.id)
      : await buildPostDocument(repo, target.id);
  return doc ? documentHash(doc) : undefined;
}

// ---------- preflight ----------

export interface PublishOffer {
  id: string;
  title: string;
}

export interface ListPreflight {
  doc: PublishedList;
  /** This list's posts that have no live public page — offered for publishing alongside. */
  unpublishedPosts: PublishOffer[];
}

export interface PostPreflight {
  doc: PublishedPost;
  /** Set when the post targets a list that has no live public page. */
  listOffer?: { listId: string; title: string };
  /** Existing posts linked from the body that have no live public page. */
  unpublishedLinkedPosts: PublishOffer[];
}

async function hasLivePage(repo: PublishRepo, target: Publication["target"]): Promise<boolean> {
  const publication = await repo.publicationFor(target);
  return isLive(publication) && onWire(publication);
}

export async function listPreflight(
  repo: PublishRepo,
  listId: string,
): Promise<ListPreflight | undefined> {
  const doc = await buildListDocument(repo, listId);
  if (!doc) return undefined;
  const posts = await repo.postsFor({ kind: "list", listId });
  const unpublishedPosts: PublishOffer[] = [];
  for (const post of posts) {
    if (!(await hasLivePage(repo, { kind: "post", id: post.id }))) {
      unpublishedPosts.push({ id: post.id, title: post.title });
    }
  }
  return { doc, unpublishedPosts };
}

export async function postPreflight(
  repo: PublishRepo,
  postId: string,
): Promise<PostPreflight | undefined> {
  const post = await repo.getPost(postId);
  const doc = await buildPostDocument(repo, postId);
  if (!post || !doc) return undefined;
  let listOffer: PostPreflight["listOffer"];
  if (post.target.kind === "list") {
    const list = await repo.getList(post.target.listId);
    if (list && !(await hasLivePage(repo, { kind: "list", id: list.id }))) {
      listOffer = { listId: list.id, title: list.name };
    }
  }
  const unpublishedLinkedPosts: PublishOffer[] = [];
  for (const linkedId of extractPostLinkIds(post.body)) {
    if (linkedId === postId) continue;
    const linked = await repo.getPost(linkedId);
    if (!linked) continue; // dangling links stay soft — nothing to offer
    if (!(await hasLivePage(repo, { kind: "post", id: linkedId }))) {
      unpublishedLinkedPosts.push({ id: linkedId, title: linked.title });
    }
  }
  return { doc, ...(listOffer !== undefined ? { listOffer } : {}), unpublishedLinkedPosts };
}

// ---------- the wire ----------

function defaultFetcher(): typeof fetch {
  return (input, init) => fetch(input, init);
}

async function putDocument(
  fetcher: typeof fetch,
  kind: "list" | "post",
  slug: string,
  token: string,
  body: string,
): Promise<Response> {
  return fetcher(shareDocumentUrl(kind, slug), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
}

function failureMessage(status: number): string {
  if (status === 429) return "Rate limited by the share service — try again in a minute.";
  if (status === 413) return "This page is too large to publish.";
  return `Publishing failed (${status.toString()}) — try again.`;
}

/**
 * PUT the document under the target's publication. A live publication updates
 * in place with its stored token; otherwise (first publish, or publishing
 * again after a revoke) a fresh token claims a fresh slug, walking `-2…-9`
 * suffixes on 403 (owned by another token) and 410 (tombstoned).
 */
async function publishDocument(
  repo: PublishRepo,
  target: Publication["target"],
  doc: PublishedList | PublishedPost,
  opts: PublishOptions,
): Promise<Publication> {
  const fetcher = opts.fetcher ?? defaultFetcher();
  const now = opts.now ?? nowIso();
  // The hash covers the content only; the version stamp rides on the wire
  // copy, so an unchanged document always hashes the same.
  const hash = await documentHash(doc);

  const existing = await repo.publicationFor(target);
  const version = isLive(existing) ? (existing.version ?? 1) + 1 : 1;
  const body = JSON.stringify({ ...doc, version, updatedAt: now });
  if (isLive(existing)) {
    if (!existing.editorToken) {
      throw new PublishError(
        "This page's editor token is missing — it cannot be updated from this device. Publish as a new page instead.",
      );
    }
    const response = await putDocument(
      fetcher,
      target.kind,
      existing.slug,
      existing.editorToken,
      body,
    );
    if (response.status === 200 || response.status === 201) {
      await repo.recordPublished(existing.id, hash, now, version);
      return (await repo.publicationFor(target)) ?? existing;
    }
    if (response.status === 410) {
      throw new PublishError(
        "This page's slug was revoked — unpublish, then publish again for a new link.",
      );
    }
    throw new PublishError(failureMessage(response.status));
  }

  const token = newEditorToken();
  const base = slugFromTitle(doc.title);
  for (const candidate of slugCandidates(base)) {
    const response = await putDocument(fetcher, target.kind, candidate, token, body);
    if (response.status === 201) {
      // The row is written only after the claim succeeds: the contract has no
      // way to move a publication between slugs, so an unclaimed row would lie.
      const publication = await repo.createPublication(target, candidate, token, now);
      await repo.recordPublished(publication.id, hash, now, version);
      return (await repo.publicationFor(target)) ?? publication;
    }
    // 403: owned by another token. 410: tombstoned — including our own earlier
    // revoke. Both walk to the next suffix (spec/src/sharing.md §The share service).
    if (response.status === 403 || response.status === 410) continue;
    throw new PublishError(failureMessage(response.status));
  }
  throw new PublishError("Every candidate slug is taken — rename it and publish again.");
}

async function publishPostDocument(
  repo: PublishRepo,
  postId: string,
  opts: PublishOptions,
): Promise<Publication> {
  const doc = await buildPostDocument(repo, postId);
  if (!doc) throw new PublishError("This post no longer exists.");
  return publishDocument(repo, { kind: "post", id: postId }, doc, opts);
}

async function publishListDocument(
  repo: PublishRepo,
  listId: string,
  opts: PublishOptions,
): Promise<Publication> {
  const doc = await buildListDocument(repo, listId);
  if (!doc) throw new PublishError("This list no longer exists.");
  return publishDocument(repo, { kind: "list", id: listId }, doc, opts);
}

// ---------- foreground actions ----------

/**
 * Publish (or update) a list's public page. `alsoPublishPostIds` — accepted
 * offers from the preflight — publish after the list has its slug so their
 * documents can link it; the list document is then republished to link them
 * back. A failure part-way leaves what already succeeded standing; retrying
 * is pressing Publish again.
 */
export async function publishList(
  repo: PublishRepo,
  listId: string,
  opts: PublishOptions & { alsoPublishPostIds?: readonly string[] } = {},
): Promise<Publication> {
  ensureReady();
  const alsoPublish = opts.alsoPublishPostIds ?? [];
  let publication = await publishListDocument(repo, listId, opts);
  if (alsoPublish.length > 0) {
    for (const postId of alsoPublish) await publishPostDocument(repo, postId, opts);
    publication = await publishListDocument(repo, listId, opts);
  }
  return publication;
}

/**
 * Publish (or update) a post's public page. Accepted preflight offers publish
 * first — linked posts so the body rewrite can link them, then a list post's
 * list so the document can carry its URL. A list published in this flow is
 * republished at the end so its posts sidebar links this post.
 */
export async function publishPost(
  repo: PublishRepo,
  postId: string,
  opts: PublishOptions & {
    publishListAlongside?: boolean;
    alsoPublishPostIds?: readonly string[];
  } = {},
): Promise<Publication> {
  ensureReady();
  for (const linkedId of opts.alsoPublishPostIds ?? []) {
    await publishPostDocument(repo, linkedId, opts);
  }
  let listId: string | undefined;
  if (opts.publishListAlongside) {
    const post = await repo.getPost(postId);
    if (post?.target.kind === "list") {
      listId = post.target.listId;
      await publishListDocument(repo, listId, opts);
    }
  }
  const publication = await publishPostDocument(repo, postId, opts);
  // Only a list published in THIS confirmed flow updates again; an already
  // published list just shows "unpublished changes" until its owner updates it.
  if (listId !== undefined) await publishListDocument(repo, listId, opts);
  return publication;
}

/**
 * Unpublish: DELETE the hosted document, then keep the local row as a revoked
 * tombstone. Repeats are 204 server-side; 404 (nothing hosted) revokes too.
 */
export async function unpublish(
  repo: PublishRepo,
  publication: Publication,
  opts: PublishOptions = {},
): Promise<void> {
  ensureReady();
  if (!publication.editorToken) {
    throw new PublishError(
      "This page's editor token is missing — it cannot be unpublished from this device. Ask the service operator to take it down.",
    );
  }
  const fetcher = opts.fetcher ?? defaultFetcher();
  const response = await fetcher(shareDocumentUrl(publication.target.kind, publication.slug), {
    method: "DELETE",
    headers: { authorization: `Bearer ${publication.editorToken}` },
  });
  if (response.status !== 204 && response.status !== 404) {
    throw new PublishError(`Unpublishing failed (${response.status.toString()}) — try again.`);
  }
  await repo.markRevoked(publication.id, opts.now ?? nowIso());
}

/**
 * Token loss is permanent (spec/src/sharing.md §The editor token): a live
 * publication without its token can never be updated or revoked through the
 * API. Revoking the local record lets the owner republish under a new slug;
 * the stale page is removed via the service's takedown contact.
 */
export async function abandonLostPublication(
  repo: PublishRepo,
  publication: Publication,
  now?: string,
): Promise<void> {
  await repo.markRevoked(publication.id, now ?? nowIso());
}

// ---------- live pages ----------

/**
 * A live page follows its source (spec/src/sharing.md §Live pages): once the
 * owner has published it, later changes go out on their own, each as the next
 * version. These are the publications that are behind right now — live, held
 * by this device, on the wire, and showing a different hash than the current
 * projection. A page whose `live` flag is false is never listed: it waits for
 * the owner to press Publish update.
 */
export async function stalePublications(
  repo: PublishRepo,
): Promise<{ publication: Publication; hash: string }[]> {
  const stale: { publication: Publication; hash: string }[] = [];
  for (const publication of await repo.livePublications()) {
    if (publication.live === false || !publication.editorToken || !onWire(publication)) continue;
    const hash = await currentDocumentHash(repo, publication.target).catch(() => undefined);
    if (hash !== undefined && hash !== publication.lastPublishedHash) {
      stale.push({ publication, hash });
    }
  }
  return stale;
}

/** Bring one live page up to date — the same PUT a pressed Publish update makes. */
export async function republish(
  repo: PublishRepo,
  publication: Publication,
  opts: PublishOptions = {},
): Promise<Publication> {
  ensureReady();
  return publication.target.kind === "list"
    ? publishListDocument(repo, publication.target.id, opts)
    : publishPostDocument(repo, publication.target.id, opts);
}
