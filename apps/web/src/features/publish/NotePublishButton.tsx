/**
 * Publish a shareable note as a standalone read-only page (book/src/notes.md):
 * `/n/<slug>` shows the latest successfully published revision only.
 */
import type { Note } from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { publicationForNote, publishNote, revokePublication } from "./publication";

export function NotePublishButton({ note }: { note: Note }) {
  const repo = useDexieRepo();
  const [busy, setBusy] = useState(false);
  const publication = useLiveQuery(() => publicationForNote(repo, note.id), [repo, note.id]);
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
          disabled={busy}
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
          setBusy(true);
          const action =
            hasPage && publication
              ? revokePublication(repo, publication.id, nowIso())
              : publishNote(repo, note, note.title ?? "A shared note", nowIso());
          void action.finally(() => setBusy(false));
        }}
        className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200 disabled:opacity-40"
      >
        {hasPage ? "Unpublish page" : "Publish page"}
      </button>
    </>
  );
}
