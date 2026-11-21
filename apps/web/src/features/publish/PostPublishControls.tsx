/**
 * Publish controls for a post (spec/src/sharing.md): the same foreground
 * grammar as a list's — Publish, Publish update, Unpublish behind the exact
 * preflight disclosure. The preflight offers to publish
 * linked-but-unpublished posts, and a list post's list, alongside.
 */
import type { Publication } from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { PreflightDialog, type PreflightOfferOption } from "./PreflightDialog";
import {
  abandonLostPublication,
  currentDocumentHash,
  fresher,
  type PostPreflight,
  postPreflight,
  publicUrl,
  publishPost,
  unpublish,
} from "./publication";

/** The list offer rides the same checkbox list as post offers, under this id. */
const LIST_OFFER = "__list__";

export function PostPublishControls({ postId }: { postId: string }) {
  const repo = useRepo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preflight, setPreflight] = useState<PostPreflight>();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [replacingLost, setReplacingLost] = useState(false);
  const [override, setOverride] = useState<Publication>();

  const liveRow = useLiveQuery(
    () => repo.publicationFor({ kind: "post", id: postId }).catch(() => undefined),
    [repo, postId],
  );
  const publication = fresher(liveRow, override);
  const live = publication !== undefined && !publication.revokedAt;
  const currentHash = useLiveQuery(
    () => currentDocumentHash(repo, { kind: "post", id: postId }).catch(() => undefined),
    [repo, postId],
  );
  const unpublishedChanges =
    live &&
    publication.lastPublishedHash !== undefined &&
    currentHash !== undefined &&
    currentHash !== publication.lastPublishedHash;

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    void action()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const openPreflight = (replaceLost = false) =>
    run(async () => {
      const computed = await postPreflight(repo, postId);
      if (!computed) return;
      setReplacingLost(replaceLost);
      setChecked(new Set());
      setPreflight(computed);
    });

  const confirmPublish = () =>
    run(async () => {
      if (replacingLost && publication) await abandonLostPublication(repo, publication);
      const published = await publishPost(repo, postId, {
        publishListAlongside: checked.has(LIST_OFFER),
        alsoPublishPostIds: [...checked].filter((id) => id !== LIST_OFFER),
      });
      setOverride(published);
      setPreflight(undefined);
      setReplacingLost(false);
    });

  const runUnpublish = () =>
    run(async () => {
      if (!publication) return;
      await unpublish(repo, publication);
      const revokedAt = nowIso();
      setOverride({ ...publication, revokedAt, updatedAt: revokedAt });
    });

  const pageUrl = live ? publicUrl("post", publication.slug) : undefined;

  const offers: PreflightOfferOption[] = preflight
    ? [
        ...(preflight.listOffer
          ? [
              {
                id: LIST_OFFER,
                label: `The list “${preflight.listOffer.title}”, so this post can link to it`,
              },
            ]
          : []),
        ...preflight.unpublishedLinkedPosts.map((post) => ({
          id: post.id,
          label: `The linked post “${post.title}”, so its link works publicly`,
        })),
      ]
    : [];

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-xs"
      data-testid="post-publish-controls"
    >
      {!live ? (
        <>
          {publication?.revokedAt ? (
            <span
              className="rounded-pill bg-wash px-2 py-0.5 font-medium text-ink/70"
              data-testid="post-publication-status"
              data-status="revoked"
            >
              Unpublished — the old link is gone for good; publishing again creates a new one
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => openPreflight()}
            className="rounded-pill border border-hairline px-2.5 py-1 font-medium text-ink/70 disabled:opacity-40"
            data-testid="publish-post"
          >
            Publish…
          </button>
        </>
      ) : (
        <>
          <span
            className={`rounded-pill px-2 py-0.5 font-medium ${
              unpublishedChanges ? "bg-hairline text-ink/70" : "bg-paper text-ink/70"
            }`}
            data-testid="post-publication-status"
            data-status={unpublishedChanges ? "unpublished-changes" : "published"}
          >
            Published{unpublishedChanges ? " · unpublished changes" : ""}
          </span>
          {pageUrl ? (
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-cobalt-deep underline"
              data-testid="post-public-link"
            >
              {pageUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : null}
          {publication.editorToken ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => openPreflight()}
                className="rounded-pill border border-hairline px-2 py-0.5 font-medium text-ink/70 disabled:opacity-40"
                data-testid="update-post-publication"
              >
                Publish update…
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={runUnpublish}
                className="rounded-pill px-2 py-0.5 font-medium text-ink/70 hover:bg-hairline disabled:opacity-40"
                data-testid="unpublish-post"
              >
                Unpublish
              </button>
            </>
          ) : (
            <>
              <span className="w-full text-[11px] text-ink/60" data-testid="token-missing">
                This page's editor token is missing — it cannot be updated or unpublished from this
                device. Publishing as a new page creates a new link; the old page is removed via the
                service's takedown contact.
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => openPreflight(true)}
                className="rounded-pill border border-hairline px-2.5 py-1 font-medium text-ink/70 disabled:opacity-40"
                data-testid="publish-post-as-new"
              >
                Publish as a new page…
              </button>
            </>
          )}
          <span className="w-full text-[11px] text-ink/60">
            Unpublishing removes the public page, but copies already downloaded and third-party
            caches cannot be remotely erased.
          </span>
        </>
      )}
      {error !== undefined ? (
        <span
          className="w-full text-accent-vermilion-deep"
          role="alert"
          data-testid="publish-error"
        >
          {error}
        </span>
      ) : null}
      {preflight ? (
        <PreflightDialog
          heading="Exactly this becomes public:"
          title={preflight.doc.title}
          places={preflight.doc.places}
          body={preflight.doc.body}
          {...(preflight.doc.list ? { listRef: preflight.doc.list } : {})}
          offers={offers}
          checked={checked}
          onToggle={(id) =>
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          busy={busy}
          onConfirm={confirmPublish}
          onCancel={() => setPreflight(undefined)}
          confirmTestId="confirm-publish-post"
        />
      ) : null}
    </div>
  );
}
