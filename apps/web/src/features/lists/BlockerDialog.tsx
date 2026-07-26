/**
 * Bottom-up teardown refusals (spec/src/posts.md §Where embeds come from):
 * every refusal is actionable — this dialog names the blockers so the owner
 * can dismantle them explicitly. Nothing authored ever dies as a side effect.
 */
import type { TeardownBlockers } from "@placemarks/domain";

export function BlockerDialog({
  title,
  blockers,
  placeNames,
  onOpenPlace,
  onClose,
}: {
  title: string;
  blockers: TeardownBlockers;
  placeNames: Readonly<Record<string, string>>;
  onOpenPlace: (placeId: string) => void;
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
              ✍ The post{" "}
              <a
                href={`/post/${encodeURIComponent(post.postId)}/edit`}
                className="font-medium text-blue-700 underline"
              >
                “{post.title}”
              </a>{" "}
              is about this list — open it and delete the post first.
            </li>
          ))}
          {blockers.members.map((placeId) => (
            <li key={placeId} data-testid="blocker-member">
              ◉{" "}
              <button
                type="button"
                className="font-medium text-blue-700 underline"
                onClick={() => onOpenPlace(placeId)}
              >
                {placeNames[placeId] ?? `Place ${placeId}`}
              </button>{" "}
              is still in this list — open the place and remove it first.
            </li>
          ))}
          {blockers.embeds.map((embed) => (
            <li key={embed.blockId} data-testid="blocker-embed">
              ⌘ Embedded in the post{" "}
              <a
                href={`/post/${encodeURIComponent(embed.postId)}/edit#${encodeURIComponent(embed.blockId)}`}
                className="font-medium text-blue-700 underline"
              >
                “{embed.postTitle}”
              </a>{" "}
              — open it and remove the embed first.
            </li>
          ))}
          {blockers.notes.map((note) => (
            <li key={note.noteId} data-testid="blocker-note">
              ✎{" "}
              <button
                type="button"
                className="font-medium text-blue-700 underline"
                onClick={() => onOpenPlace(note.placeId)}
              >
                {placeNames[note.placeId] ?? `Place ${note.placeId}`}
              </button>{" "}
              carries your note{note.title ? ` “${note.title}”` : ""} — open it and delete the note
              first.
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
