/**
 * Publish a shareable note as a standalone read-only page (spec/src/notes.md):
 * `/n/<slug>` shows the latest successfully published revision only.
 */
import type { Note } from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { publicationForNote, publishNote, revokePublication } from "./publication";

export function NotePublishButton({ note }: { note: Note }) {
  const repo = useDexieRepo();
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState(false);
  const publication = useLiveQuery(() => publicationForNote(repo, note.id), [repo, note.id]);
  // A failed revocation must never expose an action that publishes again —
  // Update stays unavailable until the outbox says no DELETE is pending
  // (plain read: unknown stays undefined).
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
  // The disclosure names where the note lives (its list or place context).
  const contextTitle = useLiveQuery(async () => {
    try {
      if (note.target.kind === "list") {
        return (await repo.getList(note.target.listId))?.name;
      }
      const place = await repo.getPlace(note.target.placeId);
      return place ? (place.lastVerified?.name ?? place.manual?.name) : undefined;
    } catch {
      return undefined; // database closing during teardown
    }
  }, [repo, note.target]);
  // The page stays reachable (and recoverable) through a failed update — the
  // last published revision is still public until revoked.
  const hasPage = Boolean(
    publication?.slug &&
      publication.status !== "revoked" &&
      publication.status !== "revoking" &&
      (publication.status === "published" || publication.publishedRevision !== undefined),
  );

  return (
    <>
      {hasPage && publication?.slug ? (
        <a
          href={`/n/${publication.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded px-1.5 text-xs text-blue-700 underline"
          data-testid="note-page-link"
        >
          Page
        </a>
      ) : null}
      {publication?.status === "failed" ? (
        <span className="px-1 text-[11px] text-red-600">
          {publication.lastError ?? "publish failed"}
        </span>
      ) : null}
      {hasPage ? (
        <button
          type="button"
          disabled={busy || pendingRevoke !== false}
          data-testid="update-note-page"
          onClick={() => {
            setBusy(true);
            void publishNote(repo, note, note.title ?? "A shared note", nowIso()).finally(() =>
              setBusy(false),
            );
          }}
          className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200 disabled:opacity-40"
        >
          Update page
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        data-testid="publish-note"
        onClick={() => {
          if (!hasPage || !publication) {
            // First publish creates a public link — stop for the exact
            // disclosure before anything leaves the device.
            setPreflight(true);
            return;
          }
          setBusy(true);
          void revokePublication(repo, publication.id, nowIso()).finally(() => setBusy(false));
        }}
        className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200 disabled:opacity-40"
      >
        {hasPage ? "Unpublish page" : "Publish page"}
      </button>
      {preflight ? (
        <div
          className="w-full rounded border border-stone-200 bg-stone-50 p-2 text-xs"
          data-testid="note-publish-preflight"
        >
          <p className="font-medium text-stone-800">
            Exactly this becomes a public read-only page:
          </p>
          {note.title ? <p className="mt-1 font-medium text-stone-900">{note.title}</p> : null}
          {contextTitle ? <p className="text-stone-500">{contextTitle}</p> : null}
          <p className="mt-1 whitespace-pre-wrap text-stone-700">{note.body}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              data-testid="confirm-publish-note"
              onClick={() => {
                setPreflight(false);
                setBusy(true);
                void publishNote(repo, note, note.title ?? "A shared note", nowIso()).finally(() =>
                  setBusy(false),
                );
              }}
              className="rounded bg-stone-800 px-2 py-0.5 font-medium text-white disabled:opacity-40"
            >
              Confirm &amp; publish
            </button>
            <button
              type="button"
              onClick={() => setPreflight(false)}
              className="rounded px-2 py-0.5 text-stone-600 hover:bg-stone-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
