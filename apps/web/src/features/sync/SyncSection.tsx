/**
 * The sync status surface (spec/src/storage-sync.md §Multi-device sync): a
 * minimal account that does nothing but name the sync scope, last-synced
 * state, pending mutation count, and conflict review. Solo, account-free use
 * is unchanged — everything here is optional.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import { completeLogin, requestLoginCode, signOut, signOutOtherDevices, syncNow } from "./engine";

export function SyncSection() {
  const repo = useDexieRepo();
  const state = useLiveQuery(() => repo.db.syncState.get("sync"), [repo]);
  const pending = useLiveQuery(() => repo.db.mutationOutbox.count(), [repo]);
  const conflicts = useLiveQuery(() => repo.db.syncConflicts.toArray(), [repo]);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"idle" | "code-sent" | "busy">("idle");
  const [message, setMessage] = useState<string>();

  const signedIn = Boolean(state?.token);

  return (
    <section className="mt-6" data-testid="sync-section">
      <h2 className="text-sm font-semibold text-stone-700">Sync between devices</h2>
      <p className="mt-1 text-xs text-stone-500">
        An account only names your sync scope — lists, posts, notes, tags, and places move between
        your signed-in devices. Without one, everything keeps working on this device alone.
      </p>

      {!signedIn ? (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Sync account email"
              className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
              data-testid="sync-email"
            />
            <button
              type="button"
              disabled={phase === "busy" || email.trim() === ""}
              className="shrink-0 rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              data-testid="sync-request-code"
              onClick={() => {
                setPhase("busy");
                setMessage(undefined);
                requestLoginCode(email.trim())
                  .then(() => {
                    setPhase("code-sent");
                    setMessage("Check your email for the sign-in code.");
                  })
                  .catch((err: unknown) => {
                    setPhase("idle");
                    setMessage(err instanceof Error ? err.message : String(err));
                  });
              }}
            >
              Send code
            </button>
          </div>
          {phase === "code-sent" ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6-digit code"
                aria-label="Sign-in code"
                className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
                data-testid="sync-code"
              />
              <button
                type="button"
                disabled={code.trim() === ""}
                className="shrink-0 rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                data-testid="sync-complete-login"
                onClick={() => {
                  setPhase("busy");
                  setMessage(undefined);
                  completeLogin(repo, email.trim(), code.trim())
                    .then(async () => {
                      setMessage("Signed in — syncing…");
                      try {
                        await syncNow(repo);
                        setMessage("Signed in and synced.");
                      } catch (err) {
                        const detail = err instanceof Error ? err.message : String(err);
                        setMessage(`Signed in, but the first sync failed: ${detail}`);
                      }
                      setPhase("idle");
                    })
                    .catch((err: unknown) => {
                      setPhase("code-sent");
                      setMessage(err instanceof Error ? err.message : String(err));
                    });
                }}
              >
                Sign in
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 space-y-1 text-xs text-stone-600" data-testid="sync-status">
          <p>
            Syncing as <span className="font-medium">{state?.email}</span>
          </p>
          <p data-testid="sync-last">
            {state?.lastSyncedAt
              ? `Last synced ${state.lastSyncedAt}`
              : "Not synced yet on this device."}
            {state?.lastError ? ` — last attempt failed: ${state.lastError}` : ""}
          </p>
          <p data-testid="sync-pending">
            {pending ?? 0} local {pending === 1 ? "change" : "changes"} waiting to sync
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={phase === "busy"}
              className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              data-testid="sync-now"
              onClick={() => {
                setPhase("busy");
                setMessage(undefined);
                syncNow(repo)
                  .then((outcome) => {
                    setMessage(
                      `Synced — pushed ${outcome.pushed.toString()}, received ${outcome.applied.toString()}.`,
                    );
                  })
                  .catch((err: unknown) =>
                    setMessage(err instanceof Error ? err.message : String(err)),
                  )
                  .finally(() => setPhase("idle"));
              }}
            >
              Sync now
            </button>
            <button
              type="button"
              disabled={phase === "busy"}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700"
              data-testid="sync-sign-out"
              onClick={() => {
                setPhase("busy");
                setMessage(undefined);
                void signOut(repo)
                  .then(() => setMessage("Signed out — local data unchanged."))
                  .catch((err: unknown) =>
                    setMessage(err instanceof Error ? err.message : String(err)),
                  )
                  .finally(() => setPhase("idle"));
              }}
            >
              Sign out
            </button>
            <button
              type="button"
              disabled={phase === "busy"}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700"
              data-testid="sync-sign-out-others"
              onClick={() => {
                setPhase("busy");
                setMessage(undefined);
                void signOutOtherDevices(repo)
                  .then(() => setMessage("Other device sessions were signed out."))
                  .catch((err: unknown) =>
                    setMessage(err instanceof Error ? err.message : String(err)),
                  )
                  .finally(() => setPhase("idle"));
              }}
            >
              Sign out other devices
            </button>
          </div>
        </div>
      )}
      {message ? (
        <p className="mt-2 text-xs text-stone-600" data-testid="sync-message">
          {message}
        </p>
      ) : null}

      {(conflicts ?? []).length > 0 ? (
        <div className="mt-3" data-testid="sync-conflicts">
          <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Rescued during sync
          </h3>
          <p className="mt-0.5 text-[11px] text-stone-500">
            These notes raced a deletion on another device. Their text is preserved here — copy what
            you need, then dismiss.
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {(conflicts ?? []).map((conflict) => (
              <li
                key={conflict.id}
                className="rounded border border-orange-200 bg-orange-50 p-2 text-xs"
                data-testid="sync-conflict"
              >
                {conflict.title ? (
                  <p className="font-medium text-stone-800">{conflict.title}</p>
                ) : null}
                <p className="whitespace-pre-wrap text-stone-700">{conflict.body}</p>
                <p className="mt-1 text-[11px] text-stone-500">{conflict.reason}</p>
                <button
                  type="button"
                  className="mt-1 rounded px-2 py-0.5 text-[11px] font-medium text-stone-600 hover:bg-orange-100"
                  data-testid="dismiss-conflict"
                  onClick={() => void repo.db.syncConflicts.delete(conflict.id)}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
