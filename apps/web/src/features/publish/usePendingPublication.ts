/**
 * The two questions every publish control asks about a hosted publication:
 *
 *  - **pendingChanges** — is there local content the public page does not have
 *    yet? Derived by comparing the target's current projection hash with
 *    `lastPublishedHash`. There is deliberately no dirty bit: a flag maintained
 *    on ~30 write paths was a second source of the same truth, and the marker
 *    jobs it queued were never sent (the drain skips payload-less jobs).
 *
 *  - **pendingRevoke** — does Retry mean DELETE or PUT? `undefined` means "not
 *    yet known", and the control keeps Retry disabled until then so the window
 *    can never default to a publish
 *    (spec/src/sharing.md §Failure isolation and revocation precedence).
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import type { DexieRepository } from "../../data/repo";
import { projectList, projectPost } from "../share/project";
import { publicListSlug } from "./publication";

export type PublicationTarget = { kind: "list" | "post"; id: string };

export interface PendingPublication {
  pendingChanges: boolean | undefined;
  /** `undefined` until the job row has answered. */
  pendingRevoke: boolean | undefined;
}

/** The hash the target projects to right now, computed exactly as publishing does. */
async function projectedHash(
  repo: DexieRepository,
  target: PublicationTarget,
): Promise<string | undefined> {
  if (target.kind === "list") return (await projectList(repo, target.id))?.guide.contentHash;
  const post = await repo.getPost(target.id);
  if (!post) return undefined;
  // A post's document names its list's public slug, so the hash depends on it.
  const listSlug = await publicListSlug(repo, post.listId);
  return (await projectPost(repo, target.id, listSlug))?.guide.contentHash;
}

export function usePendingPublication(
  repo: DexieRepository,
  target: PublicationTarget,
  publication: { id: string; lastPublishedHash?: string } | undefined,
): PendingPublication {
  const lastPublishedHash = publication?.lastPublishedHash;
  const pendingChanges = useLiveQuery(async () => {
    if (!lastPublishedHash) return false;
    try {
      const hash = await projectedHash(repo, target);
      return hash !== undefined && hash !== lastPublishedHash;
    } catch {
      return false; // database closing during teardown
    }
  }, [repo, target.kind, target.id, lastPublishedHash]);

  // Deliberately NOT a live query. A live query keeps its previous value while
  // re-running, so "unknown" would exist only before the very first result —
  // and Retry would briefly read as a publish after the publication changes.
  // An explicit reset to `undefined` on every change is what makes the unknown
  // window real.
  const [pendingRevoke, setPendingRevoke] = useState<boolean | undefined>(undefined);
  // Depends on the whole publication, not just its id: a revoke that just
  // failed flips status without changing the id, and Retry's meaning has to be
  // re-resolved from scratch when it does. The live query hands us a fresh
  // object per emission, so this re-asks on every publication change.
  useEffect(() => {
    let cancelled = false;
    setPendingRevoke(undefined);
    const publicationId = publication?.id;
    if (!publicationId) return;
    repo.db.publicationJobs
      .get(publicationId)
      .then((row) => {
        if (!cancelled) setPendingRevoke(row?.revoke !== undefined);
      })
      .catch(() => {
        // database closing during teardown — stay unknown
      });
    return () => {
      cancelled = true;
    };
  }, [repo, publication]);

  return { pendingChanges, pendingRevoke };
}
