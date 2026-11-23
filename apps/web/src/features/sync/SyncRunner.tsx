/**
 * Keeps this device in step (spec/src/sync.md §The cycle). Mounted once. A
 * cycle runs when the app opens, when the network returns, when the tab comes
 * back into view, about once a minute while it is in view, and a few seconds
 * after something here changes. Sync is off until the owner turns it on, and
 * then this component is the only thing that starts a cycle without a press.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { runSync, storedCode } from "./controller";
import { pendingCount } from "./engine";

/** Let a burst of edits settle into one cycle. */
export const SYNC_SETTLE_MS = 3000;
/** How often an open, visible tab asks whether another device changed something. */
export const SYNC_POLL_MS = 60_000;

export function SyncRunner() {
  const { db } = useDexieRepo();
  const code = useLiveQuery(() => storedCode(db), [db]);
  const on = code !== undefined;
  // Re-evaluated whenever a synced row changes: Dexie observes what the query read.
  const pending = useLiveQuery(() => (on ? pendingCount(db) : 0), [db, on]);

  useEffect(() => {
    if (!on) return;
    void runSync(db);
    const wake = () => {
      if (document.visibilityState === "visible") void runSync(db);
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    const poll = setInterval(wake, SYNC_POLL_MS);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      clearInterval(poll);
    };
  }, [db, on]);

  useEffect(() => {
    if (!on || !pending) return;
    const timer = setTimeout(() => void runSync(db), SYNC_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [db, on, pending]);

  return null;
}
