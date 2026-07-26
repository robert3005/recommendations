/**
 * Bottom-up teardown refusals (spec/src/posts.md §Where embeds come from):
 * every refusal is actionable — this dialog names the blockers so the owner can
 * dismantle them explicitly. Nothing authored ever dies as a side effect.
 *
 * One list with a `switch` on kind, not four arrays with four renderers. The
 * notes section additionally offers a single confirmed bulk delete: the
 * guarantee is that the owner decides, not that they click once per note.
 */
import type { Blocker } from "@placemarks/domain";
import { useState } from "react";

function postHref(postId: string, blockId?: string): string {
  const base = `/post/${encodeURIComponent(postId)}/edit`;
  return blockId ? `${base}#${encodeURIComponent(blockId)}` : base;
}

export function BlockerDialog({
  title,
  blockers,
  placeNames,
  onOpenPlace,
  onDeleteNotes,
  onClose,
}: {
  title: string;
  blockers: Blocker[];
  placeNames: Readonly<Record<string, string>>;
  onOpenPlace: (placeId: string) => void;
  /** Delete every listed note, after the owner confirms. Absent = no bulk action. */
  onDeleteNotes?: (noteIds: string[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const [confirmingNotes, setConfirmingNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const noteBlockers = blockers.filter((blocker) => blocker.kind === "note");
  const placeName = (placeId?: string) =>
    placeId ? (placeNames[placeId] ?? `Place ${placeId}`) : "this place";

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      data-testid="blocker-dialog"
    >
      <div className="w-full max-w-md rounded-lg bg-paper p-4 shadow-xl">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-sm text-ink-2">
          Nothing you wrote is deleted as a side effect — remove these first:
        </p>
        <ul className="mt-2 space-y-1 text-sm text-ink">
          {blockers.map((blocker) => {
            if (blocker.kind === "post") {
              return (
                <li key={`post-${blocker.id}`} data-testid="blocker-post">
                  ✍ The post{" "}
                  <a href={postHref(blocker.id)} className="font-medium text-water-ink underline">
                    “{blocker.label ?? "Untitled post"}”
                  </a>{" "}
                  is about this list — open it and delete the post first.
                </li>
              );
            }
            if (blocker.kind === "member") {
              return (
                <li key={`member-${blocker.id}`} data-testid="blocker-member">
                  ◉{" "}
                  <button
                    type="button"
                    className="font-medium text-water-ink underline"
                    onClick={() => onOpenPlace(blocker.id)}
                  >
                    {placeName(blocker.placeId ?? blocker.id)}
                  </button>{" "}
                  is still in this list — open the place and remove it first.
                </li>
              );
            }
            if (blocker.kind === "embed") {
              return (
                <li key={`embed-${blocker.id}`} data-testid="blocker-embed">
                  ⌘ Embedded in the post{" "}
                  <a
                    href={postHref(blocker.postId ?? "", blocker.id)}
                    className="font-medium text-water-ink underline"
                  >
                    “{blocker.label ?? "Untitled post"}”
                  </a>{" "}
                  — open it and remove the embed first.
                </li>
              );
            }
            return (
              <li key={`note-${blocker.id}`} data-testid="blocker-note">
                ✎{" "}
                <button
                  type="button"
                  className="font-medium text-water-ink underline"
                  onClick={() => blocker.placeId && onOpenPlace(blocker.placeId)}
                >
                  {placeName(blocker.placeId)}
                </button>{" "}
                carries your note{blocker.label ? ` “${blocker.label}”` : ""} — open it and delete
                the note first.
              </li>
            );
          })}
        </ul>

        {onDeleteNotes && noteBlockers.length > 0 ? (
          <div className="mt-3 rounded border border-rule bg-land p-2 text-sm">
            {confirmingNotes ? (
              <>
                <p className="text-ink-2">
                  Delete {noteBlockers.length} {noteBlockers.length === 1 ? "note" : "notes"}{" "}
                  permanently? This cannot be undone.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded bg-coral-ink px-2 py-1 font-medium text-white disabled:opacity-40"
                    data-testid="blocker-delete-notes-confirm"
                    onClick={() => {
                      setBusy(true);
                      void Promise.resolve(
                        onDeleteNotes(noteBlockers.map((blocker) => blocker.id)),
                      ).finally(() => {
                        setBusy(false);
                        setConfirmingNotes(false);
                      });
                    }}
                  >
                    Delete them
                  </button>
                  <button
                    type="button"
                    className="rounded border border-rule px-2 py-1 font-medium text-ink-2"
                    onClick={() => setConfirmingNotes(false)}
                  >
                    Keep them
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="font-medium text-water-ink underline"
                data-testid="blocker-delete-notes"
                onClick={() => setConfirmingNotes(true)}
              >
                Delete these {noteBlockers.length} {noteBlockers.length === 1 ? "note" : "notes"}…
              </button>
            )}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded bg-ink px-3 py-1.5 text-sm font-medium text-white"
            onClick={onClose}
            data-testid="blocker-dialog-close"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
