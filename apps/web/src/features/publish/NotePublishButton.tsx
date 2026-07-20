/**
 * Publish a shareable note as a standalone read-only page (spec/src/notes.md):
 * `/n/<slug>` shows the latest successfully published revision only.
 */
import type { Note } from "@placemarks/domain";
import type { SharedPlaceAnchor } from "@placemarks/schemas";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { anchorForPlace, omittedImageAlts, withImagePlaceholders } from "../share/project";
import { publicationForNote, publishNote, revokePublication } from "./publication";

/**
 * The exact copied place context a note page carries (spec/src/sharing.md:
 * the preflight lists the exact evidence that leaves the device — every
 * field, not a summary).
 */
function AnchorDisclosure({ anchor }: { anchor: SharedPlaceAnchor }) {
  if (anchor.kind === "manual") {
    return (
      <div className="mt-1 rounded border border-stone-200 bg-white p-1.5 text-[11px] text-stone-600">
        <p className="font-medium text-stone-700">Owner-provided place facts (no OSM claim):</p>
        <p>
          {anchor.name} · {anchor.lat}, {anchor.lng}
          {anchor.category ? ` · ${anchor.category}` : ""}
        </p>
      </div>
    );
  }
  const evidence = anchor.lastVerified;
  return (
    <div className="mt-1 rounded border border-stone-200 bg-white p-1.5 text-[11px] text-stone-600">
      <p className="font-medium text-stone-700">Copied place context that leaves the device:</p>
      <p>
        {evidence.name ? `${evidence.name} · ` : ""}
        {evidence.category} — OSM {anchor.currentOsmRef.type} {anchor.currentOsmRef.id}
        {evidence.osmVersion !== undefined ? ` v${evidence.osmVersion.toString()}` : ""}
      </p>
      <p>
        {evidence.lat}, {evidence.lng}
        {evidence.address ? ` · ${evidence.address}` : ""}
      </p>
      {evidence.website ? <p>{evidence.website}</p> : null}
      {evidence.phone ? <p>{evidence.phone}</p> : null}
      {evidence.stableIds
        ? Object.entries(evidence.stableIds).map(([key, value]) => (
            <p key={key}>
              {key}: {value}
            </p>
          ))
        : null}
      <p>
        observed {evidence.observedAt} · {evidence.source} · {evidence.license} ·{" "}
        {evidence.attribution}
      </p>
      <p>
        First-seen recovery evidence (observed {anchor.firstSeen.observedAt}) travels with the page
        too.
      </p>
    </div>
  );
}

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
  // The disclosure names where the note lives (its post or place context).
  const contextTitle = useLiveQuery(async () => {
    try {
      if (note.target.kind === "post") {
        return (await repo.getPost(note.target.postId))?.title;
      }
      const place = await repo.getPlace(note.target.placeId);
      return place ? (place.lastVerified?.name ?? place.manual?.name) : undefined;
    } catch {
      return undefined; // database closing during teardown
    }
  }, [repo, note.target]);
  // The full copied anchor the published page would carry — disclosed
  // verbatim before anything leaves the device.
  const anchor = useLiveQuery(async () => {
    try {
      if (note.target.kind !== "place") return undefined;
      const place = await repo.getPlace(note.target.placeId);
      return place ? anchorForPlace(place) : undefined;
    } catch {
      return undefined; // database closing during teardown
    }
  }, [repo, note.target]);
  // The page stays reachable (and recoverable) through a failed update — the
  // last published revision is still public until the revocation actually
  // lands, so `revoking` keeps the link and never re-exposes a first-publish
  // action (spec/src/sharing.md §Failure isolation and revocation precedence).
  const hasPage = Boolean(
    publication?.slug &&
      publication.status !== "revoked" &&
      (publication.status === "published" ||
        publication.status === "revoking" ||
        publication.publishedRevision !== undefined),
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
          {/* The body as it actually publishes — images become placeholders. */}
          <p className="mt-1 whitespace-pre-wrap text-stone-700">
            {withImagePlaceholders(note.body)}
          </p>
          {omittedImageAlts(note.body).length > 0 ? (
            <p className="mt-1 text-[11px] text-stone-500">
              Images never leave the device — omitted: {omittedImageAlts(note.body).join(", ")}
            </p>
          ) : null}
          {anchor ? <AnchorDisclosure anchor={anchor} /> : null}
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
