/**
 * Publish controls for a list (spec/src/sharing.md): Publish, Publish update,
 * Unpublish — foreground actions behind a preflight that discloses exactly
 * what leaves. "Unpublished changes" compares the current projection's hash
 * with the publication's `lastPublishedHash`.
 */
import type { Publication } from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { PostPublishControls } from "./PostPublishControls";
import { PreflightDialog } from "./PreflightDialog";
import {
  abandonLostPublication,
  currentDocumentHash,
  fresher,
  type ListPreflight,
  listPreflight,
  publicUrl,
  publishList,
  unpublish,
} from "./publication";

/** One entry point for both publishable targets — pages pass whichever they hold. */
export function PublishControls(props: { listId: string } | { target: Publication["target"] }) {
  if ("target" in props) {
    return props.target.kind === "post" ? (
      <PostPublishControls postId={props.target.id} />
    ) : (
      <ListPublishControls listId={props.target.id} />
    );
  }
  return <ListPublishControls listId={props.listId} />;
}

export function ListPublishControls({ listId }: { listId: string }) {
  const repo = useRepo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preflight, setPreflight] = useState<ListPreflight>();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [replacingLost, setReplacingLost] = useState(false);
  // Non-Dexie state changes (the awaited publish itself) re-render through
  // this override; the live query wins again as soon as it re-emits.
  const [override, setOverride] = useState<Publication>();

  const liveRow = useLiveQuery(
    () => repo.publicationFor({ kind: "list", id: listId }).catch(() => undefined),
    [repo, listId],
  );
  const publication = fresher(liveRow, override);
  const live = publication !== undefined && !publication.revokedAt;
  const currentHash = useLiveQuery(
    () => currentDocumentHash(repo, { kind: "list", id: listId }).catch(() => undefined),
    [repo, listId],
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
      const computed = await listPreflight(repo, listId);
      if (!computed) return;
      setReplacingLost(replaceLost);
      // A list's write-up belongs with it: its posts are offered ticked, and
      // the owner unticks what should stay private.
      setChecked(new Set(computed.unpublishedPosts.map((post) => post.id)));
      setPreflight(computed);
    });

  const list = useLiveQuery(() => repo.getList(listId), [repo, listId]);
  const [copied, setCopied] = useState(false);
  const copyLink = (url: string) => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };
  const share = (url: string) => {
    // The phone's own share sheet when there is one; the clipboard otherwise.
    if (typeof navigator.share === "function") {
      void navigator.share({ title: list?.name ?? "Placemarks", url }).catch(() => undefined);
    } else copyLink(url);
  };
  const liveUpdates = publication?.live !== false;

  const confirmPublish = () =>
    run(async () => {
      if (replacingLost && publication) await abandonLostPublication(repo, publication);
      const published = await publishList(repo, listId, { alsoPublishPostIds: [...checked] });
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

  const pageUrl = live ? publicUrl("list", publication.slug) : undefined;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="publish-controls">
      {!live ? (
        <>
          {publication?.revokedAt ? (
            <span
              className="rounded-pill bg-wash px-2 py-0.5 font-medium text-ink/70"
              data-testid="publication-status"
              data-status="revoked"
            >
              Unpublished — the old link is gone for good; publishing again creates a new one
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => openPreflight()}
            className="rounded-pill bg-ink px-3 py-1 text-sm font-medium text-paper disabled:opacity-40"
            data-testid="publish-list"
          >
            Share this list…
          </button>
        </>
      ) : (
        <>
          <span
            className={`rounded-pill px-2 py-0.5 font-medium ${
              unpublishedChanges ? "bg-hairline text-ink/70" : "bg-paper text-ink/70"
            }`}
            data-testid="publication-status"
            data-status={unpublishedChanges ? "unpublished-changes" : "published"}
          >
            {liveUpdates ? "Live" : "Published"}
            {publication.version ? ` · v${publication.version.toString()}` : ""}
            {unpublishedChanges ? (liveUpdates ? " · updating…" : " · unpublished changes") : ""}
          </span>
          {pageUrl ? (
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-cobalt-deep underline"
              data-testid="public-link"
            >
              {pageUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : null}
          {pageUrl ? (
            <button
              type="button"
              onClick={() => share(pageUrl)}
              className="rounded-pill bg-ink px-2.5 py-0.5 font-medium text-paper"
              data-testid="share-link"
            >
              {copied ? "Link copied" : "Share link"}
            </button>
          ) : null}
          {publication.editorToken ? (
            <>
              <label className="flex items-center gap-1 text-ink/70">
                <input
                  type="checkbox"
                  checked={liveUpdates}
                  onChange={(e) => void repo.setPublicationLive(publication.id, e.target.checked)}
                  data-testid="live-toggle"
                />
                Update the page automatically
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => openPreflight()}
                className="rounded-pill border border-hairline px-2 py-0.5 font-medium text-ink/70 disabled:opacity-40"
                data-testid="publish-update"
              >
                Publish update…
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={runUnpublish}
                className="rounded-pill px-2 py-0.5 font-medium text-ink/70 hover:bg-hairline disabled:opacity-40"
                data-testid="unpublish"
              >
                Unpublish
              </button>
            </>
          ) : (
            <>
              {/* Token loss is permanent (spec/src/sharing.md §The editor token). */}
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
                data-testid="publish-as-new"
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
          {...(preflight.doc.description ? { intro: preflight.doc.description } : {})}
          {...(preflight.doc.author ? { author: preflight.doc.author } : {})}
          extra={
            <label className="mt-1.5 flex items-center gap-1.5 text-ink/70">
              <input
                type="checkbox"
                checked={list?.shareNotes !== false}
                onChange={(e) =>
                  void repo
                    .setListShareNotes(listId, e.target.checked)
                    .then(() => listPreflight(repo, listId))
                    .then((next) => {
                      if (next) setPreflight(next);
                    })
                }
                data-testid="share-notes"
              />
              Include my notes, tags and ratings for these places
            </label>
          }
          offers={preflight.unpublishedPosts.map((post) => ({
            id: post.id,
            label: `The post “${post.title}”, so the public list can link to it`,
          }))}
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
          confirmTestId="confirm-publish-list"
        />
      ) : null}
    </div>
  );
}
