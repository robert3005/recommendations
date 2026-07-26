/**
 * Sharing controls for a post (spec/src/posts.md §Publishing): a snapshot
 * link and a hosted named link under /s/posts. The shared post names its list
 * and carries the list's public slug when one exists; the preflight offers to
 * publish the list alongside the post — declining publishes the post with the
 * list named but unlinked.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { type ProjectionStats, projectPost } from "../share/project";
import { SharePreview } from "../share/SharePreview";
import { encodeSnapshot, SnapshotTooLargeError } from "../share/snapshot";
import {
  publicationChannel,
  publicationForList,
  publicationForPost,
  publicListSlug,
  publishList,
  publishPost,
  revokePublication,
} from "./publication";
import { usePendingPublication } from "./usePendingPublication";

export function PostPublishControls({ postId }: { postId: string }) {
  const repo = useDexieRepo();
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<{
    guide: SharedGuide;
    listUnpublished: boolean;
  } | null>(null);
  const [publishListToo, setPublishListToo] = useState(false);
  const [sharing, setSharing] = useState<{
    guide: SharedGuide;
    stats: ProjectionStats;
    snapshotUrl?: string;
    compressedBytes?: number;
    tooLargeReason?: string;
  }>();
  const [copied, setCopied] = useState(false);
  const publication = useLiveQuery(
    () => publicationForPost(repo, postId).catch(() => undefined),
    [repo, postId],
  );
  const { pendingChanges, pendingRevoke } = usePendingPublication(
    repo,
    { kind: "post", id: postId },
    publication,
  );

  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  const openPreflight = async () => {
    const post = await repo.getPost(postId);
    if (!post) return;
    const listSlug = await publicListSlug(repo, post.listId);
    const projection = await projectPost(repo, postId, listSlug);
    if (!projection) return;
    const listPublication = await publicationForList(repo, post.listId);
    const listUnpublished =
      listSlug === undefined &&
      (listPublication === undefined || listPublication.status === "revoked");
    setPublishListToo(false);
    setPreflight({ guide: projection.guide, listUnpublished });
  };

  const confirmPublish = async () => {
    const post = await repo.getPost(postId);
    if (!post) return;
    // Publishing the list first lets the post document carry its fresh slug.
    if (publishListToo) await publishList(repo, post.listId, nowIso());
    await publishPost(repo, postId, nowIso());
  };

  const openSnapshot = async () => {
    const post = await repo.getPost(postId);
    if (!post) return;
    const listSlug = await publicListSlug(repo, post.listId);
    const projection = await projectPost(repo, postId, listSlug);
    if (!projection) return;
    try {
      const { fragment, compressedBytes } = encodeSnapshot(projection.guide);
      setSharing({
        guide: projection.guide,
        stats: projection.stats,
        snapshotUrl: `${window.location.origin}/l#${fragment}`,
        compressedBytes,
      });
    } catch (err) {
      setSharing({
        guide: projection.guide,
        stats: projection.stats,
        tooLargeReason:
          err instanceof SnapshotTooLargeError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
    setCopied(false);
  };

  const channel = publication ? publicationChannel(publication) : "posts";
  const publicUrl = publication?.slug
    ? `${window.location.origin}/${channel === "lists" ? "l" : "p"}/${publication.slug}`
    : null;
  const status = publication?.status;

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-xs"
      data-testid="post-publish-controls"
    >
      <button
        type="button"
        className="rounded bg-ink px-2.5 py-1 font-medium text-white"
        data-testid="share-post"
        onClick={() => void openSnapshot()}
      >
        Share…
      </button>
      {sharing ? (
        <SharePreview
          title={sharing.guide.title}
          guide={sharing.guide}
          stats={sharing.stats}
          {...(sharing.snapshotUrl ? { snapshotUrl: sharing.snapshotUrl } : {})}
          {...(sharing.compressedBytes !== undefined
            ? { compressedBytes: sharing.compressedBytes }
            : {})}
          {...(sharing.tooLargeReason ? { tooLargeReason: sharing.tooLargeReason } : {})}
          copied={copied}
          onCopy={() => {
            if (sharing.snapshotUrl) {
              void navigator.clipboard.writeText(sharing.snapshotUrl).then(() => setCopied(true));
            }
          }}
          onClose={() => setSharing(undefined)}
        />
      ) : null}
      {!publication || status === "revoked" ? (
        <>
          {status === "revoked" ? (
            <span
              className="rounded-full bg-rule px-2 py-0.5 font-medium text-ink-2"
              data-testid="post-publication-status"
              data-status="revoked"
            >
              revoked — the public link is gone
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void openPreflight()}
            className="rounded border border-rule px-2.5 py-1 font-medium text-ink-2 disabled:opacity-40"
            data-testid="publish-post"
          >
            Publish hosted link…
          </button>
          {preflight ? (
            <div
              className="w-full rounded border border-rule bg-land p-2"
              data-testid="post-publish-preflight"
            >
              <p className="font-medium text-ink">
                Exactly this becomes public at a hosted link — “{preflight.guide.title}”:
              </p>
              {preflight.guide.list ? (
                <p className="text-ink-2">
                  From the list: <span className="font-medium">{preflight.guide.list.title}</span>
                  {preflight.guide.list.slug
                    ? ` (links to /l/${preflight.guide.list.slug})`
                    : " (named, not linked — the list has no public page)"}
                </p>
              ) : null}
              <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-ink-2">
                {preflight.guide.blocks.map((block) => (
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
                        {(block.tags ?? []).length > 0 ? (
                          <span className="text-ink-3">
                            {" "}
                            · tags: {(block.tags ?? []).join(", ")}
                          </span>
                        ) : null}
                        {(block.notes ?? []).map((note, index) => (
                          <span
                            key={`${block.id}-note-${index.toString()}`}
                            className="block border-l-2 border-rule pl-2 text-ink-2"
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
              {preflight.listUnpublished ? (
                <label className="mt-2 flex items-center gap-1.5 text-ink-2">
                  <input
                    type="checkbox"
                    checked={publishListToo}
                    onChange={(e) => setPublishListToo(e.target.checked)}
                    data-testid="publish-list-alongside"
                  />
                  Also publish “{preflight.guide.list?.title ?? "the list"}” as its own public page,
                  so the post can link to it
                </label>
              ) : null}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPreflight(null);
                    act(confirmPublish);
                  }}
                  className="rounded bg-ink px-2.5 py-1 font-medium text-white disabled:opacity-40"
                  data-testid="confirm-publish-post"
                >
                  Publish
                </button>
                <button
                  type="button"
                  onClick={() => setPreflight(null)}
                  className="rounded px-2.5 py-1 text-ink-2 hover:bg-rule"
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
                ? "bg-leaf-wash text-leaf-ink"
                : status === "failed"
                  ? "bg-coral-wash text-coral-ink"
                  : "bg-rule text-ink-2"
            }`}
            data-testid="post-publication-status"
            data-status={status}
          >
            {status}
            {pendingChanges && (status === "published" || status === "queued")
              ? " · local changes not yet published"
              : ""}
          </span>
          {publicUrl &&
          (status === "published" || (status === "queued" && publication.lastPublishedHash)) ? (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-water-ink underline"
              data-testid="post-public-link"
            >
              {publicUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : null}
          {publication.lastError && status === "failed" ? (
            <span className="text-coral-ink">{publication.lastError}</span>
          ) : null}
          <button
            type="button"
            disabled={busy || (status === "failed" && pendingRevoke === undefined)}
            onClick={() =>
              act(() =>
                pendingRevoke
                  ? revokePublication(repo, publication.id, nowIso())
                  : publishPost(repo, postId, nowIso()),
              )
            }
            className="rounded border border-rule px-2.5 py-1 font-medium text-ink-2 disabled:opacity-40"
            data-testid="update-post-publication"
          >
            {status === "failed" ? "Retry" : "Publish update"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => revokePublication(repo, publication.id, nowIso()))}
            className="rounded px-2.5 py-1 text-ink-2 hover:bg-rule disabled:opacity-40"
            data-testid="unpublish-post"
          >
            Unpublish
          </button>
        </>
      )}
    </div>
  );
}
