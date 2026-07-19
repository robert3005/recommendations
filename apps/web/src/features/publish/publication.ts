/**
 * Hosted publication (book/src/sharing.md §Mode B, §Local publication record):
 * the client generates a ≥256-bit editor token and persists it before the
 * first request; jobs are durable, idempotent (job id = Idempotency-Key), and
 * conditional (If-Match on the server revision). A failed or offline publish
 * never rolls back the public document; the UI derives "changes pending" from
 * localRevision vs lastPublishedLocalRevision.
 */
import type { Note, Publication } from "@placemarks/domain";
import { normalizeSlug, RESERVED_SLUGS, type SharedNote } from "@placemarks/schemas";
import { SHARE_API_URL } from "../../config";
import type { DexieRepository } from "../../data/repo";
import { newId } from "../../lib/id";
import { count, reportError } from "../../lib/metrics";
import { anchorForPlace, projectGuide, withImagePlaceholders } from "../share/project";

/** The hosted publication for a note page, if any. */
export async function publicationForNote(
  repo: DexieRepository,
  noteId: string,
): Promise<Publication | undefined> {
  const rows = (await repo.db.publications.toArray()).filter(
    (p) => !p.deleted && p.target.kind === "note" && p.target.id === noteId && p.mode === "hosted",
  );
  // A live publication outranks a revoked tombstone of the same target.
  return rows.find((p) => p.status !== "revoked") ?? rows[0];
}

/** Publish (or update) a standalone note page (book/src/notes.md). */
export async function publishNote(
  repo: DexieRepository,
  note: Note,
  contextTitle: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<Publication | undefined> {
  if (!note.shareable) return undefined;
  let publication = await publicationForNote(repo, note.id);
  // A revoked page republishes as a fresh claim, never a tombstone update.
  if (publication?.status === "revoked") publication = undefined;
  const slug = publication?.slug ?? slugFor(note.title ?? contextTitle);
  // A place note carries its durable OSM anchor (ref + copied recovery
  // evidence) so the page keeps resolving (book/src/notes.md).
  let context: SharedNote["context"] = { kind: "list", listTitle: contextTitle };
  if (note.target.kind === "place") {
    const place = await repo.getPlace(note.target.placeId);
    const anchor = place ? anchorForPlace(place) : undefined;
    if (anchor) context = { kind: "place", place: anchor };
  }
  const document: SharedNote = {
    v: 1,
    slug,
    ...(note.title ? { title: note.title } : {}),
    context,
    body: withImagePlaceholders(note.body),
    media: [], // hosted media pipeline is a follow-up; images stay placeholders
    contentHash: note.updatedAt,
    publishedAt: now,
  };
  if (!publication) {
    const credentialId = newId();
    await repo.db.credentials.put({
      id: credentialId,
      token: newEditorToken(),
      createdAt: now,
      updatedAt: now,
    });
    publication = {
      id: newId(),
      target: { kind: "note", id: note.id },
      mode: "hosted",
      slug,
      credentialId,
      status: "queued",
      localRevision: document.contentHash,
      createdAt: now,
      updatedAt: now,
    };
  } else {
    publication = {
      ...publication,
      status: publication.status === "published" ? "queued" : publication.status,
      localRevision: document.contentHash,
      updatedAt: now,
    };
  }
  await repo.db.publications.put(publication);
  await enqueuePublish(repo, publication.id, document.contentHash, JSON.stringify(document), now);
  await runPublicationOutbox(repo, fetcher);
  return (await repo.db.publications.get(publication.id)) ?? publication;
}

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
    (p) => !p.deleted && p.target.kind === "list" && p.target.id === listId && p.mode === "hosted",
  );
  // A live publication outranks a revoked tombstone of the same target.
  return rows.find((p) => p.status !== "revoked") ?? rows[0];
}

async function projectListDocument(
  repo: DexieRepository,
  listId: string,
): Promise<{ body: string; revision: string } | undefined> {
  const projection = await projectGuide(repo, listId);
  if (!projection) return undefined;
  return { body: JSON.stringify(projection.guide), revision: projection.guide.contentHash };
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
  if (!publication) {
    // The token exists durably before the first network request ever fires.
    const credentialId = newId();
    await repo.db.credentials.put({
      id: credentialId,
      token: newEditorToken(),
      createdAt: now,
      updatedAt: now,
    });
    publication = {
      id: newId(),
      target: { kind: "list", id: listId },
      mode: "hosted",
      slug: slugFor(list.name),
      credentialId,
      status: "queued",
      localRevision: document.revision,
      createdAt: now,
      updatedAt: now,
    };
  } else {
    publication = {
      ...publication,
      status: publication.status === "published" ? "queued" : publication.status,
      localRevision: document.revision,
      updatedAt: now,
    };
  }
  await repo.db.publications.put(publication);
  await enqueuePublish(repo, publication.id, document.revision, document.body, now);
  await runPublicationOutbox(repo, fetcher);
  return (await repo.db.publications.get(publication.id)) ?? publication;
}

/**
 * One durable publish job per publication: a retry reuses the failed job (and
 * its Idempotency-Key); a newer revision replaces the pending payload.
 */
async function enqueuePublish(
  repo: DexieRepository,
  publicationId: string,
  localRevision: string,
  payload: string | undefined,
  now: string,
): Promise<void> {
  const pending = (await repo.db.publicationOutbox.toArray()).find(
    (job) => job.publicationId === publicationId && job.action === "publish",
  );
  if (pending && (pending.attempts === 0 || pending.localRevision === localRevision)) {
    await repo.db.publicationOutbox.put({
      ...pending,
      localRevision,
      ...(payload !== undefined ? { payload } : {}),
    });
    return;
  }
  // An attempted key may already have committed server-side — never attach a
  // different payload to it; the new revision goes out under a fresh key.
  if (pending) await repo.db.publicationOutbox.delete(pending.id);
  await repo.db.publicationOutbox.put({
    id: newId(),
    publicationId,
    action: "publish",
    localRevision,
    ...(payload !== undefined ? { payload } : {}),
    createdAt: now,
    attempts: 0,
  });
}

export async function revokePublication(
  repo: DexieRepository,
  publicationId: string,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const exists = await repo.db.publications.get(publicationId);
  if (!exists) return;
  // The revocation state and its durable DELETE job are ONE local transition:
  // a failed write leaves the prior state (and any publish marker) untouched,
  // and the network never runs without a durable revoke job.
  await repo.db.transaction("rw", [repo.db.publications, repo.db.publicationOutbox], async () => {
    const publication = await repo.db.publications.get(publicationId);
    if (!publication) return;
    // An explicit revocation supersedes any unsent update — a failed draft
    // publish must never strand the unpublish.
    const jobs = await repo.db.publicationOutbox.toArray();
    for (const job of jobs) {
      if (job.publicationId === publicationId && job.action === "publish") {
        await repo.db.publicationOutbox.delete(job.id);
      }
    }
    await repo.db.publications.put({ ...publication, status: "revoking", updatedAt: now });
    // A failed earlier revocation retries under its original idempotency key.
    const pendingRevoke = jobs.find(
      (job) => job.publicationId === publicationId && job.action === "revoke",
    );
    if (!pendingRevoke) {
      await repo.db.publicationOutbox.put({
        id: newId(),
        publicationId,
        action: "revoke",
        localRevision: publication.localRevision,
        createdAt: now,
        attempts: 0,
      });
    }
  });
  await runPublicationOutbox(repo, fetcher);
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * The private Bearer credential never crosses an explicitly insecure
 * transport: an absolute non-localhost http: share URL blocks all mutations
 * (book/src/sharing.md: TLS is mandatory).
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
export async function runPublicationOutbox(
  repo: DexieRepository,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const jobs = (await repo.db.publicationOutbox.toArray()).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1,
  );
  if (jobs.length > 0 && insecureShareTransport()) {
    const nowIso = new Date().toISOString();
    for (const publicationId of new Set(jobs.map((job) => job.publicationId))) {
      const publication = await repo.db.publications.get(publicationId);
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
  // A failing page never starves another: order holds per publication only.
  const stalled = new Set<string>();
  for (const job of jobs) {
    if (stalled.has(job.publicationId)) continue;
    const publication = await repo.db.publications.get(job.publicationId);
    if (!publication?.slug || !publication.credentialId) {
      await repo.db.publicationOutbox.delete(job.id);
      continue;
    }
    const credential = await repo.db.credentials.get(publication.credentialId);
    if (!credential) {
      // Losing the device-held token makes the page uneditable — the failure
      // is explicit and recoverable (restore the encrypted secrets bundle).
      await repo.db.publications.put({
        ...publication,
        status: "failed",
        lastError:
          "editor credential missing — restore it from an encrypted backup to update this page",
        updatedAt: new Date().toISOString(),
      });
      stalled.add(job.publicationId);
      continue;
    }
    // A delayed older job must never overwrite a newer revision: a publish job
    // with a captured payload is stale once the publication moved past it.
    if (
      job.action === "publish" &&
      job.payload !== undefined &&
      job.localRevision !== publication.localRevision
    ) {
      await repo.db.publicationOutbox.delete(job.id);
      continue;
    }
    // A payload-less job is a passive dirty marker: only an explicit publish
    // action for its publication attaches a payload and sends it. A launch
    // retry (or a drain for another page) must never auto-publish local edits
    // (book/src/sharing.md: the page changes only when the creator publishes).
    if (job.action === "publish" && job.payload === undefined) continue;
    const payload = job.payload;
    const localRevision = job.localRevision;
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.token}`,
      "idempotency-key": job.id,
      "content-type": "application/json",
    };
    const base = `${SHARE_API_URL}/s/${publication.target.kind === "note" ? "notes" : "lists"}`;
    const nowIso = new Date().toISOString();

    try {
      if (job.action === "revoke") {
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
          await repo.db.publicationOutbox.delete(job.id);
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
          // A note document embeds its public slug — keep it aligned with the
          // slug actually being claimed.
          const document = JSON.parse(payload ?? "{}") as { slug?: string };
          if (publication.target.kind === "note") document.slug = candidate;
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

      const fresh = (await repo.db.publications.get(job.publicationId)) ?? publication;
      // An edit that landed while this revision was in flight stays queued —
      // the completed older publish must not clear it.
      const superseded = fresh.localRevision !== publication.localRevision;
      await repo.db.publications.put({
        ...fresh,
        slug: outcome.slug,
        status: superseded ? "queued" : "published",
        publishedRevision: outcome.revision,
        ...(superseded ? {} : { localRevision }),
        lastPublishedLocalRevision: localRevision,
        lastPublishedHash: localRevision,
        publishedAt: nowIso,
        updatedAt: nowIso,
      });
      if (!superseded) {
        await repo.db.publicationOutbox.delete(job.id);
      } else {
        // The job's key has now been sent for THIS payload — the surviving
        // dirty marker must go out under a fresh key, never a reused one.
        const current = await repo.db.publicationOutbox.get(job.id);
        if (current) {
          await repo.db.publicationOutbox.delete(current.id);
          await repo.db.publicationOutbox.put({ ...current, id: newId() });
        }
      }
      count("publish.success");
    } catch (err) {
      reportError("publish", err);
      const fresh = (await repo.db.publications.get(job.publicationId)) ?? publication;
      const transient =
        err instanceof TypeError || // network failure
        (err instanceof Error && RETRYABLE.has(Number(err.message.match(/\((\d+)\)/)?.[1])));
      await repo.db.publications.put({
        ...fresh,
        status: "failed",
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: nowIso,
      });
      await repo.db.publicationOutbox.put({
        ...job,
        attempts: job.attempts + 1,
        lastError: err instanceof Error ? err.message : String(err),
      });
      if (!transient && job.attempts >= 5) await repo.db.publicationOutbox.delete(job.id);
      stalled.add(job.publicationId);
    }
  }
}
