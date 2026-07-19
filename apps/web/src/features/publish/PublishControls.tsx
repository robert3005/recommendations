/**
 * Hosted-link controls for a list (spec/src/sharing.md §Mode B): publish,
 * update, unpublish. The owner always sees local-draft vs published state; the
 * public URL shows the latest successfully published revision only.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { projectGuide } from "../share/project";
import { publicationForList, publishList, revokePublication } from "./publication";

export function PublishControls({ listId }: { listId: string }) {
  const repo = useDexieRepo();
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<SharedGuide | null>(null);
  const publication = useLiveQuery(
    () => publicationForList(repo, listId).catch(() => undefined),
    [repo, listId],
  );
  const pendingChanges = useLiveQuery(async () => {
    if (!publication?.lastPublishedLocalRevision) return false;
    try {
      const projection = await projectGuide(repo, listId);
      return projection
        ? projection.guide.contentHash !== publication.lastPublishedLocalRevision
        : false;
    } catch {
      return false; // database closing during teardown
    }
  }, [repo, listId, publication?.lastPublishedLocalRevision]);
  // A failed revocation retries its pending DELETE — never a publish. The
  // lookup is a plain read (not a live query): unknown stays undefined so
  // Retry cannot enable — let alone default to a publish — before the outbox
  // has actually answered.
  const [pendingRevoke, setPendingRevoke] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setPendingRevoke(undefined);
    // Re-check on every publication emission — a status flip (e.g. a revoke
    // that just failed) changes whether a DELETE is still pending.
    const publicationId = publication?.id;
    if (!publicationId) return;
    repo.db.publicationOutbox
      .toArray()
      .then((jobs) => {
        if (!cancelled) {
          setPendingRevoke(
            jobs.some((job) => job.publicationId === publicationId && job.action === "revoke"),
          );
        }
      })
      .catch(() => {
        // database closing during teardown — stay unknown
      });
    return () => {
      cancelled = true;
    };
  }, [repo, publication]);

  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  const publicUrl = publication?.slug ? `${window.location.origin}/l/${publication.slug}` : null;
  const status = publication?.status;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="publish-controls">
      {!publication || status === "revoked" ? (
        <>
          {status === "revoked" ? (
            <span
              className="rounded-full bg-stone-200 px-2 py-0.5 font-medium text-stone-700"
              data-testid="publication-status"
              data-status="revoked"
            >
              revoked — the public link is gone
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              // Preflight first: nothing leaves the device until the exact
              // projection is disclosed and confirmed (spec/src/sharing.md).
              void projectGuide(repo, listId).then((projection) => {
                if (projection) setPreflight(projection.guide);
              })
            }
            className="rounded border border-stone-300 px-2.5 py-1 font-medium text-stone-700 disabled:opacity-40"
            data-testid="publish-list"
          >
            Publish hosted link…
          </button>
          {preflight ? (
            <div
              className="w-full rounded border border-stone-200 bg-stone-50 p-2"
              data-testid="publish-preflight"
            >
              <p className="font-medium text-stone-800">
                Exactly this becomes public at a hosted link — “{preflight.title}”:
              </p>
              <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-stone-700">
                {preflight.blocks.map((block) => (
                  <li key={block.id}>
                    {block.type === "section" ? (
                      <span>
                        {block.note.title ? `${block.note.title}: ` : ""}
                        {block.note.body}
                      </span>
                    ) : (
                      <span>
                        <span className="font-medium">
                          {block.place.kind === "osm"
                            ? (block.place.lastVerified.name ?? "Unnamed place")
                            : block.place.name}
                        </span>{" "}
                        ·{" "}
                        {block.place.kind === "osm"
                          ? `${block.place.lastVerified.lat.toString()}, ${block.place.lastVerified.lng.toString()}`
                          : `${block.place.lat.toString()}, ${block.place.lng.toString()}`}
                        {(block.notes ?? []).map((note, index) => (
                          <span
                            key={`${block.id}-note-${index.toString()}`}
                            className="block border-l-2 border-stone-300 pl-2 text-stone-600"
                          >
                            {note.title ? `${note.title}: ` : ""}
                            {note.body}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPreflight(null);
                    act(() => publishList(repo, listId, nowIso()));
                  }}
                  className="rounded bg-stone-800 px-2.5 py-1 font-medium text-white disabled:opacity-40"
                  data-testid="confirm-publish-list"
                >
                  Publish
                </button>
                <button
                  type="button"
                  onClick={() => setPreflight(null)}
                  className="rounded px-2.5 py-1 text-stone-600 hover:bg-stone-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              status === "published"
                ? "bg-emerald-100 text-emerald-800"
                : status === "failed"
                  ? "bg-red-100 text-red-800"
                  : "bg-stone-200 text-stone-700"
            }`}
            data-testid="publication-status"
            data-status={status}
          >
            {status}
            {pendingChanges && (status === "published" || status === "queued")
              ? " · local changes not yet published"
              : ""}
          </span>
          {publicUrl &&
          (status === "published" ||
            (status === "queued" && publication.lastPublishedLocalRevision)) ? (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 underline"
              data-testid="public-link"
            >
              {publicUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : null}
          {publication.lastError && status === "failed" ? (
            <span className="text-red-700">{publication.lastError}</span>
          ) : null}
          <button
            type="button"
            // A failed state is ambiguous until the outbox says whether an
            // unpublish is pending — Retry stays disabled until its meaning
            // is known, so the window can never default to a publish.
            disabled={busy || (status === "failed" && pendingRevoke === undefined)}
            onClick={() =>
              act(() =>
                // A pending DELETE job resumes; only a failed publish retries
                // publishing.
                pendingRevoke
                  ? revokePublication(repo, publication.id, nowIso())
                  : publishList(repo, listId, nowIso()),
              )
            }
            className="rounded border border-stone-300 px-2 py-0.5 font-medium text-stone-600 disabled:opacity-40"
            data-testid="publish-update"
          >
            {status === "failed" ? "Retry" : "Publish update"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => revokePublication(repo, publication.id, nowIso()))}
            className="rounded px-2 py-0.5 text-red-700 hover:bg-red-50 disabled:opacity-40"
            data-testid="unpublish"
          >
            Unpublish
          </button>
          <span className="w-full text-[11px] text-stone-500">
            Unpublishing removes the public page, but already downloaded copies and third-party
            caches cannot be remotely erased or removed.
          </span>
        </>
      )}
    </div>
  );
}
