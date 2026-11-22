/**
 * Teardown refusals (spec/src/data-model.md §Teardown): deletion runs
 * bottom-up, and every refusal is actionable — this dialog names the blockers
 * so the owner dismantles them deliberately. Nothing authored or published
 * dies as a side effect of deleting something else.
 */
import type { Blocker } from "../../data/repo";

function postHref(postId: string): string {
  return `/post/${encodeURIComponent(postId)}`;
}

function label(names: Readonly<Record<string, string>> | undefined, id: string, fallback: string) {
  return names?.[id] ?? fallback;
}

export function BlockerDialog({
  title,
  blockers,
  names,
  onClose,
}: {
  title: string;
  blockers: Blocker[];
  /** id → display name (post titles, place names) where the caller knows them. */
  names?: Readonly<Record<string, string>>;
  onClose: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="blocker-dialog"
    >
      <div className="w-full max-w-md rounded-crisp border border-hairline bg-paper p-4">
        <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-sm text-ink/70">
          Nothing you wrote or published is deleted as a side effect — clear these first:
        </p>
        <ul className="mt-2 space-y-1 text-sm text-ink">
          {blockers.flatMap((blocker) => {
            if (blocker.kind === "place-has-posts") {
              return blocker.ids.map((postId) => (
                <li key={`place-post-${postId}`} data-testid="blocker-place-has-posts">
                  ✍ The post{" "}
                  <a href={postHref(postId)} className="font-medium underline">
                    “{label(names, postId, "Untitled post")}”
                  </a>{" "}
                  is about this place — delete the post first.
                </li>
              ));
            }
            if (blocker.kind === "list-has-posts") {
              return blocker.ids.map((postId) => (
                <li key={`list-post-${postId}`} data-testid="blocker-list-has-posts">
                  ✍ The post{" "}
                  <a href={postHref(postId)} className="font-medium underline">
                    “{label(names, postId, "Untitled post")}”
                  </a>{" "}
                  is about this list — delete the post first.
                </li>
              ));
            }
            // live-publication (spec/src/data-model.md §Teardown rule 3): no
            // public page is ever orphaned by a local delete.
            return (
              <li key="live-publication" data-testid="blocker-live-publication">
                ⚑ This is published at a public link — unpublish it first.
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded-pill bg-ink px-3 py-1.5 text-sm font-medium text-paper"
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
