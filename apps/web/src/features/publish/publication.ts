/**
 * Hosted publication (spec/src/sharing.md §Mode B, §Local publication record):
 * the client generates a ≥256-bit editor token and persists it before the
 * first request; jobs are durable, idempotent (job id = Idempotency-Key), and
 * conditional (If-Match on the server revision). A failed or offline publish
 * never rolls back the public document; the UI derives "changes pending" by
 * comparing the target's current projection hash with lastPublishedHash.
 */
import type { Publication } from "@placemarks/domain";
import { normalizeSlug, RESERVED_SLUGS } from "@placemarks/schemas";
import { SHARE_API_URL } from "../../config";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";
import { count, reportError } from "../../lib/metrics";
import { projectList, projectPost } from "../share/project";

export function newEditorToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function slugFor(name: string): string {
  const base = normalizeSlug(name);
  // A name with no ASCII slug characters still publishes — under a generated
  // slug rather than a broken empty one.
  const slug =
    base.length >= 3
      ? base
      : base.length > 0
        ? `list-${base}`.slice(0, 60)
        : `guide-${newId().slice(0, 8)}`;
  return RESERVED_SLUGS.has(slug) ? `${slug}-guide` : slug;
}

export async function publicationForList(
  repo: DexieRepository,
  listId: string,
): Promise<Publication | undefined> {
  const rows = (await repo.db.publications.toArray()).filter(
    (p) => !p.deleted && p.target.kind === "list" && p.target.id === listId,
  );
  // A live publication outranks a revoked tombstone of the same target.
  return rows.find((p) => p.status !== "revoked") ?? rows[0];
}

async function projectListDocument(
  repo: DexieRepository,
  listId: string,
): Promise<{ body: string; revision: string } | undefined> {
  const projection = await projectList(repo, listId);
  if (!projection) return undefined;
  return { body: JSON.stringify(projection.guide), revision: projection.guide.contentHash };
}

/** The hosted publication for a post, if any. */
export async function publicationForPost(
  repo: DexieRepository,
  postId: string,
): Promise<Publication | undefined> {
  const rows = (await repo.db.publications.toArray()).filter(
    (p) => !p.deleted && p.target.kind === "post" && p.target.id === postId,
  );
  // A live publication outranks a revoked tombstone of the same target.
  return rows.find((p) => p.status !== "revoked") ?? rows[0];
}

/**
 * The list's public slug a shared post may carry (spec/src/posts.md
 * §Publishing): only a slug that has actually been claimed publicly; a
 * revoked list page drops the link at the next successful post publish.
 */
export async function publicListSlug(
  repo: DexieRepository,
  listId: string,
): Promise<string | undefined> {
  const publication = await publicationForList(repo, listId);
  if (!publication?.slug) return undefined;
  if (publication.status === "revoked" || publication.status === "revoking") return undefined;
  return publication.publishedRevision !== undefined ? publication.slug : undefined;
}

/** Create (or re-queue) the hosted publication for a list and run the outbox. */
export async function publishList(
  repo: DexieRepository,
  listId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<Publication | undefined> {
  const list = await repo.getList(listId);
  const document = await projectListDocument(repo, listId);
  if (!list || !document) return undefined;

  let publication = await publicationForList(repo, listId);
  // A revoked slug is tombstoned forever — publishing again means a fresh
  // publication with a fresh claim, never an update to the tombstone.
  if (publication?.status === "revoked") publication = undefined;
  let newCredential:
    | { id: string; token: string; createdAt: string; updatedAt: string }
    | undefined;
  if (!publication) {
    // The token exists durably before the first network request ever fires.
    const credentialId = newId();
    newCredential = {
      id: credentialId,
      token: newEditorToken(),
      createdAt: now,
      updatedAt: now,
    };
    publication = {
      id: newId(),
      target: { kind: "list", id: listId },
      slug: slugFor(list.name),
      credentialId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
  } else {
    publication = {
      ...publication,
      status: publication.status === "published" ? "queued" : publication.status,
      updatedAt: now,
    };
  }
  await repo.db.transaction(
    "rw",
    [repo.db.credentials, repo.db.publications, repo.db.publicationJobs],
    async () => {
      if (newCredential) await repo.db.credentials.put(newCredential);
      await repo.db.publications.put(publication);
      await enqueuePublish(repo, publication.id, document.revision, document.body, now);
    },
  );
  await runPublicationOutbox(repo, fetcher);
  return (await repo.db.publications.get(publication.id)) ?? publication;
}

/** Create (or re-queue) the hosted publication for a post and run the outbox. */
export async function publishPost(
  repo: DexieRepository,
  postId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<Publication | undefined> {
  const post = await repo.getPost(postId);
  if (!post) return undefined;
  // The shared post names its list and carries the list's public slug when
  // one exists (spec/src/posts.md §Publishing).
  const listSlug = await publicListSlug(repo, post.listId);
  const projection = await projectPost(repo, postId, listSlug);
  if (!projection) return undefined;
  const document = {
    body: JSON.stringify(projection.guide),
    revision: projection.guide.contentHash,
  };

  let publication = await publicationForPost(repo, postId);
  // A revoked slug is tombstoned forever — publishing again means a fresh
  // publication with a fresh claim, never an update to the tombstone.
  if (publication?.status === "revoked") publication = undefined;
  let newCredential:
    | { id: string; token: string; createdAt: string; updatedAt: string }
    | undefined;
  if (!publication) {
    const credentialId = newId();
    newCredential = {
      id: credentialId,
      token: newEditorToken(),
      createdAt: now,
      updatedAt: now,
    };
    publication = {
      id: newId(),
      target: { kind: "post", id: postId },
      slug: slugFor(post.title),
      credentialId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
  } else {
    publication = {
      ...publication,
      status: publication.status === "published" ? "queued" : publication.status,
      updatedAt: now,
    };
  }
  await repo.db.transaction(
    "rw",
    [repo.db.credentials, repo.db.publications, repo.db.publicationJobs],
    async () => {
      if (newCredential) await repo.db.credentials.put(newCredential);
      await repo.db.publications.put(publication);
      await enqueuePublish(repo, publication.id, document.revision, document.body, now);
    },
  );
  await runPublicationOutbox(repo, fetcher);
  return (await repo.db.publications.get(publication.id)) ?? publication;
}

/** The share-service path segment for a publication, implied by its target kind. */
export function publicationChannel(publication: Publication): "lists" | "posts" {
  return publication.target.kind === "post" ? "posts" : "lists";
}

/**
 * One pending publish per publication. A retry reuses the failed job's key; a
 * newer revision replaces the pending payload — unless the key has already been
 * attempted, in which case it may have committed server-side and the new
 * revision must go out under a fresh key.
 */
async function enqueuePublish(
  repo: DexieRepository,
  publicationId: string,
  hash: string,
  payload: string | undefined,
  now: string,
): Promise<void> {
  const row = (await repo.db.publicationJobs.get(publicationId)) ?? { publicationId };
  const pending = row.publish;
  const reusable = pending && (pending.attempts === 0 || pending.hash === hash);
  await repo.db.publicationJobs.put({
    ...row,
    publish: reusable
      ? { ...pending, hash, ...(payload !== undefined ? { payload } : {}) }
      : {
          key: newId(),
          hash,
          ...(payload !== undefined ? { payload } : {}),
          createdAt: now,
          attempts: 0,
        },
  });
}

export async function revokePublication(
  repo: DexieRepository,
  publicationId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  // The state change, publish-job supersession, and durable DELETE job are one
  // IndexedDB commit. Process death at any await boundary therefore leaves
  // either the complete old state or the complete revocation transition.
  const scheduled = await repo.db.transaction(
    "rw",
    [repo.db.publications, repo.db.publicationJobs],
    async () => {
      const prior = await repo.db.publications.get(publicationId);
      if (!prior) return false;
      const row = await repo.db.publicationJobs.get(publicationId);
      await repo.db.publications.put({ ...prior, status: "revoking", updatedAt: now });
      // Dropping `publish` is how an explicit revocation supersedes an unsent
      // update; a failed earlier revocation keeps its original key so the retry
      // is idempotent.
      await repo.db.publicationJobs.put({
        publicationId,
        revoke: row?.revoke ?? { key: newId(), createdAt: now, attempts: 0 },
      });
      return true;
    },
  );
  if (!scheduled) return;
  await runPublicationOutbox(repo, fetcher);
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * The private Bearer credential never crosses an explicitly insecure
 * transport: an absolute non-localhost http: share URL blocks all mutations
 * (spec/src/sharing.md: TLS is mandatory).
 */
function insecureShareTransport(): boolean {
  if (!SHARE_API_URL) return false; // same-origin relative path
  try {
    const url = new URL(SHARE_API_URL, "https://placeholder.invalid");
    return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Drain the durable outbox. Jobs process in order per publication; a completed
 * older job can never roll back a newer one (If-Match + captured payloads).
 */
/** The hash the publication's target projects to right now, if it still exists. */
async function currentProjectionHash(
  repo: DexieRepository,
  target: { kind: "list" | "post"; id: string },
): Promise<string | undefined> {
  try {
    if (target.kind === "list") return (await projectList(repo, target.id))?.guide.contentHash;
    // A post's document names its list's public slug, so the hash must be
    // computed the same way publishPost computes it or every job looks stale.
    const post = await repo.getPost(target.id);
    if (!post) return undefined;
    const listSlug = await publicListSlug(repo, post.listId);
    return (await projectPost(repo, target.id, listSlug))?.guide.contentHash;
  } catch {
    return undefined; // database closing, or a target mid-teardown
  }
}

export async function runPublicationOutbox(
  repo: DexieRepository,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const rows = await repo.db.publicationJobs.toArray();
  if (rows.length > 0 && insecureShareTransport()) {
    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const publication = await repo.db.publications.get(row.publicationId);
      if (!publication) continue;
      await repo.db.publications.put({
        ...publication,
        status: "failed",
        lastError: "the share service URL is not HTTPS — refusing to send the editor token",
        updatedAt: nowIso,
      });
    }
    return;
  }
  // One row per publication, so a failing page cannot starve another: each
  // iteration is an independent publication.
  for (const row of rows) {
    const publication = await repo.db.publications.get(row.publicationId);
    if (!publication?.slug || !publication.credentialId) {
      await repo.db.publicationJobs.delete(row.publicationId);
      continue;
    }
    const credential = await repo.db.credentials.get(publication.credentialId);
    if (!credential) {
      // The editor token is device-held by design: losing the device means the
      // page can no longer be updated or revoked from anywhere else.
      await repo.db.publications.put({
        ...publication,
        status: "failed",
        lastError:
          "editor credential missing — this page can only be updated from the device that published it",
        updatedAt: new Date().toISOString(),
      });
      continue;
    }
    // Revocation always wins: precedence is which slot is set, not a scan.
    const revoking = row.revoke !== undefined;
    const job = row.revoke ?? row.publish;
    if (!job) {
      await repo.db.publicationJobs.delete(row.publicationId);
      continue;
    }
    // A publish job carries the hash it was created for. If the library has
    // moved on — a delayed or offline job resurfacing after a newer revision
    // won — it must never overwrite the newer public document; the owner
    // republishes instead. Revocations carry no revision and always apply.
    if (!revoking) {
      const currentHash = await currentProjectionHash(repo, publication.target);
      if (job.hash === undefined || (currentHash !== undefined && job.hash !== currentHash)) {
        await repo.db.publicationJobs.delete(row.publicationId);
        continue;
      }
    }
    const payload = job.payload;
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.token}`,
      "idempotency-key": job.key,
      "content-type": "application/json",
    };
    const base = `${SHARE_API_URL}/s/${publicationChannel(publication)}`;
    const nowIso = new Date().toISOString();

    try {
      if (revoking) {
        const response = await fetcher(`${base}/${publication.slug}`, {
          method: "DELETE",
          headers: {
            ...headers,
            "if-match": `"${(publication.publishedRevision ?? 1).toString()}"`,
          },
        });
        if (response.status === 204 || response.status === 404) {
          await repo.db.publications.put({
            ...publication,
            status: "revoked",
            updatedAt: nowIso,
          });
          await repo.db.publicationJobs.delete(row.publicationId);
          continue;
        }
        throw new Error(`revoke failed (${response.status.toString()})`);
      }

      await repo.db.publications.put({ ...publication, status: "publishing", updatedAt: nowIso });
      let outcome: { slug: string; revision: number } | undefined;
      if (publication.publishedRevision === undefined) {
        // First publish: claim the slug, walking suffixes on collisions.
        const candidates = [
          publication.slug,
          ...Array.from({ length: 8 }, (_, i) => `${publication.slug}-${(i + 2).toString()}`),
        ];
        for (const candidate of candidates) {
          const document = JSON.parse(payload ?? "{}") as { slug?: string };
          const response = await fetcher(base, {
            method: "POST",
            headers,
            body: JSON.stringify({ desiredSlug: candidate, document }),
          });
          if (response.status === 201) {
            outcome = (await response.json()) as { slug: string; revision: number };
            break;
          }
          if (response.status !== 409)
            throw new Error(`publish failed (${response.status.toString()})`);
          // The slug may already be ours from a commit whose ack was lost —
          // reclaim with our token before walking away from it.
          const probe = await fetcher(`${base}/${candidate}`, { method: "GET" });
          if (probe.status === 200) {
            const revision = Number(
              (probe.headers.get("etag") ?? "").match(/^"(\d+)"$/)?.[1] ?? Number.NaN,
            );
            if (Number.isFinite(revision)) {
              const reclaim = await fetcher(`${base}/${candidate}`, {
                method: "PUT",
                headers: { ...headers, "if-match": `"${revision.toString()}"` },
                body: JSON.stringify({ document }),
              });
              if (reclaim.status === 200) {
                outcome = (await reclaim.json()) as { slug: string; revision: number };
                break;
              }
            }
          }
        }
        if (!outcome) throw new Error("no available slug — try renaming the list");
      } else {
        const response = await fetcher(`${base}/${publication.slug}`, {
          method: "PUT",
          headers: { ...headers, "if-match": `"${publication.publishedRevision.toString()}"` },
          body: JSON.stringify({ document: JSON.parse(payload ?? "{}") }),
        });
        if (response.status !== 200)
          throw new Error(`update failed (${response.status.toString()})`);
        outcome = (await response.json()) as { slug: string; revision: number };
      }

      const fresh = (await repo.db.publications.get(row.publicationId)) ?? publication;
      const current = await repo.db.publicationJobs.get(row.publicationId);
      // An edit that landed while this revision was in flight left a newer
      // pending publish; the completed older one must not clear it. Its key has
      // now been sent for THIS payload, so the survivor gets a fresh one.
      const superseded = current?.publish !== undefined && current.publish.hash !== job.hash;
      await repo.db.publications.put({
        ...fresh,
        slug: outcome.slug,
        status: superseded ? "queued" : "published",
        publishedRevision: outcome.revision,
        ...(job.hash !== undefined ? { lastPublishedHash: job.hash } : {}),
        publishedAt: nowIso,
        updatedAt: nowIso,
      });
      if (superseded && current?.publish) {
        await repo.db.publicationJobs.put({
          ...current,
          publish: { ...current.publish, key: newId(), attempts: 0 },
        });
      } else {
        await repo.db.publicationJobs.delete(row.publicationId);
      }
      count("publish.success");
    } catch (err) {
      reportError("publish", err);
      const fresh = (await repo.db.publications.get(row.publicationId)) ?? publication;
      const transient =
        err instanceof TypeError || // network failure
        (err instanceof Error && RETRYABLE.has(Number(err.message.match(/\((\d+)\)/)?.[1])));
      const message = err instanceof Error ? err.message : String(err);
      await repo.db.publications.put({
        ...fresh,
        status: "failed",
        lastError: message,
        updatedAt: nowIso,
      });
      const attempted = { ...job, attempts: job.attempts + 1, lastError: message };
      // Exhausted PUBLISH drafts are dropped — but a revocation is never
      // abandoned: the pending DELETE (under its original idempotency key) is
      // what keeps Retry an unpublish and can never turn it back into a publish
      // (spec/src/sharing.md §Failure isolation and revocation precedence).
      if (!revoking && !transient && attempted.attempts >= 5) {
        const remaining = await repo.db.publicationJobs.get(row.publicationId);
        if (remaining?.revoke) {
          await repo.db.publicationJobs.put({
            publicationId: row.publicationId,
            revoke: remaining.revoke,
          });
        } else {
          await repo.db.publicationJobs.delete(row.publicationId);
        }
        continue;
      }
      const stored = (await repo.db.publicationJobs.get(row.publicationId)) ?? {
        publicationId: row.publicationId,
      };
      await repo.db.publicationJobs.put({
        ...stored,
        ...(revoking ? { revoke: attempted } : { publish: attempted }),
      });
    }
  }
}
