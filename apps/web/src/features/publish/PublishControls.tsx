/**
 * Hosted-link controls for a list (book/src/sharing.md §Mode B): publish,
 * update, unpublish. The owner always sees local-draft vs published state; the
 * public URL shows the latest successfully published revision only.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { projectGuide } from "../share/project";
import { publicationForList, publishList, revokePublication } from "./publication";

export function PublishControls({ listId }: { listId: string }) {
  const repo = useDexieRepo();
  const [busy, setBusy] = useState(false);
  const publication = useLiveQuery(() => publicationForList(repo, listId), [repo, listId]);
  const pendingChanges = useLiveQuery(async () => {
    if (!publication?.lastPublishedLocalRevision) return false;
    const projection = await projectGuide(repo, listId);
    return projection
      ? projection.guide.contentHash !== publication.lastPublishedLocalRevision
      : false;
  }, [repo, listId, publication?.lastPublishedLocalRevision]);

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
            onClick={() => act(() => publishList(repo, listId, nowIso()))}
            className="rounded border border-stone-300 px-2.5 py-1 font-medium text-stone-700 disabled:opacity-40"
            data-testid="publish-list"
          >
            Publish hosted link…
          </button>
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
            disabled={busy}
            onClick={() => act(() => publishList(repo, listId, nowIso()))}
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
        </>
      )}
    </div>
  );
}
