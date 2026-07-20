/**
 * Bottom-up teardown refusals (spec/src/posts.md §Where embeds come from):
 * every refusal is actionable — this dialog names the blockers so the owner
 * can dismantle them explicitly. Nothing authored ever dies as a side effect.
 */
import type { TeardownBlockers } from "@placemarks/domain";

export function BlockerDialog({
  title,
  blockers,
  onClose,
}: {
  title: string;
  blockers: TeardownBlockers;
  onClose: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      data-testid="blocker-dialog"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl">
        <h2 className="text-base font-semibold text-stone-900">{title}</h2>
        <p className="mt-1 text-sm text-stone-600">
          Nothing you wrote is deleted as a side effect — remove these first:
        </p>
        <ul className="mt-2 space-y-1 text-sm text-stone-800">
          {blockers.posts.map((post) => (
            <li key={post.postId} data-testid="blocker-post">
              ✍ The post <span className="font-medium">“{post.title}”</span> is about this list —
              delete the post first.
            </li>
          ))}
          {blockers.members.length > 0 ? (
            <li data-testid="blocker-members">
              ◉ {blockers.members.length}{" "}
              {blockers.members.length === 1 ? "place is" : "places are"} still in this list —
              remove them first (Edit mode has “Remove all places”).
            </li>
          ) : null}
          {blockers.embeds.map((embed) => (
            <li key={embed.blockId} data-testid="blocker-embed">
              ⌘ Embedded in the post <span className="font-medium">“{embed.postTitle}”</span> —
              remove the embed from the post first.
            </li>
          ))}
          {blockers.notes.map((note) => (
            <li key={note.noteId} data-testid="blocker-note">
              ✎ Carries your note{note.title ? ` “${note.title}”` : ""} — delete the note first.
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
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
