/**
 * Keeps live pages up to date (spec/src/sharing.md §Live pages). Mounted once
 * in the app shell. It watches for published pages whose source has changed
 * and, after the edits settle, republishes each as its next version. Nothing
 * is queued: a page that could not be updated (offline, rate limited) is
 * still listed as behind, and is tried again on the next change or when the
 * network returns. A page the owner switched to manual is never touched.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { republish, stalePublications } from "./publication";

/** Wait this long after the last change, so typing a note is one update, not twenty. */
export const LIVE_SETTLE_MS = 4000;

export function LivePublisher({ settleMs = LIVE_SETTLE_MS }: { settleMs?: number }) {
  const repo = useRepo();
  // Bumped when the browser comes back online: a retry trigger without a queue.
  const [online, setOnline] = useState(0);
  useEffect(() => {
    const bump = () => setOnline((n) => n + 1);
    window.addEventListener("online", bump);
    return () => window.removeEventListener("online", bump);
  }, []);

  const stale = useLiveQuery(() => stalePublications(repo).catch(() => []), [repo]);
  // Identity of "what is behind, and with which content": the timer re-arms
  // on every further edit (a new hash) and never for an unchanged failure, so
  // a page that cannot be updated is not retried in a loop.
  const signature = (stale ?? []).map((s) => `${s.publication.id}:${s.hash}`).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for `stale`; `online` is a deliberate retry trigger
  useEffect(() => {
    if (!stale || stale.length === 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        for (const { publication } of stale) {
          // Best effort: a failure leaves the page behind, visibly, on its controls.
          await republish(repo, publication).catch(() => undefined);
        }
      })();
    }, settleMs);
    return () => clearTimeout(timer);
  }, [signature, online, repo, settleMs]);

  return null;
}
