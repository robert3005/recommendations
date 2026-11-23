/**
 * Settings → Sync (spec/src/sync.md §Pairing). Off by default. Turning it on
 * makes a library key on this device and shows it once as a code and as a QR
 * link; a second device joins by opening the link or typing the code. There
 * is no account — the code is the only way in, and the section says so.
 */
import { useLiveQuery } from "dexie-react-hooks";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { useDexieRepo } from "../../data/RepoContext";
import {
  deleteSyncedCopy,
  joinSync,
  leaveSync,
  runSync,
  startSync,
  storedCode,
  useSyncStatus,
} from "./controller";
import { pairingLink, parseLibraryCode } from "./crypto";
import { pendingCount } from "./engine";

/** The pairing link as an SVG path — drawn in ink on paper so it follows the theme. */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) d += `M${col.toString()} ${row.toString()}h1v1h-1z`;
      }
    }
    return { size: count, path: d };
  }, [text]);
  return (
    <svg
      viewBox={`-2 -2 ${(size + 4).toString()} ${(size + 4).toString()}`}
      className="size-44 rounded-crisp border border-hairline bg-white"
      role="img"
      aria-label="QR code of the pairing link"
      data-testid="sync-qr"
    >
      {/* Always dark on white: scanners need the contrast whatever the theme. */}
      <path d={path} fill="#171716" />
    </svg>
  );
}

export function SyncSection() {
  const { db } = useDexieRepo();
  const code = useLiveQuery(() => storedCode(db), [db]);
  const pending = useLiveQuery(() => (code ? pendingCount(db) : 0), [db, code]);
  const status = useSyncStatus();
  const [joinText, setJoinText] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // A pairing link opens Settings with the code in the URL fragment — which a
  // browser never sends anywhere. Fill the field, clear the address bar, and
  // wait for the owner to press Join.
  useEffect(() => {
    const fromLink = parseLibraryCode(window.location.hash);
    if (!fromLink || !window.location.hash.includes("pair=")) return;
    setJoinText(fromLink);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const act = (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(undefined);
    work()
      .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const link = code ? pairingLink(code, window.location.origin) : undefined;

  return (
    <section className="mt-6" id="sync" data-testid="sync-settings">
      <h2 className="text-sm font-semibold text-ink/70">Sync between devices</h2>

      {code === undefined ? (
        <>
          <p className="mt-1 text-xs text-ink/60">
            Keep the same library on your phone, tablet and computer. Places, tags, notes, lists,
            views and posts sync; review insights and import history stay on each device. The
            library is encrypted on this device before it is sent, so the service stores it but
            cannot read it. There is no account: a code made here is the only way in.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await startSync(db);
                  setShowCode(true);
                })
              }
              className="rounded-pill bg-ink px-3 py-1.5 text-sm font-medium text-paper disabled:opacity-40"
              data-testid="sync-start"
            >
              Turn on sync
            </button>
          </div>
          <div className="mt-3">
            <label className="block text-xs font-medium text-ink">
              Or join a library another device started
              <span className="mt-1 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={joinText}
                  onChange={(e) => setJoinText(e.target.value)}
                  placeholder="Paste the code or the pairing link"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-pill border border-hairline bg-paper px-3 py-1.5 font-mono text-xs text-ink focus:border-ink focus:outline-none"
                  data-testid="sync-join-code"
                />
                <button
                  type="button"
                  disabled={busy || parseLibraryCode(joinText) === undefined}
                  onClick={() => act(() => joinSync(db, joinText).then(() => setJoinText("")))}
                  className="rounded-pill border border-ink px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-40"
                  data-testid="sync-join"
                >
                  Join
                </button>
              </span>
            </label>
            <p className="mt-1 text-xs text-ink/60">
              Anything already saved on this device is kept and merged into that library.
            </p>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-ink" data-testid="sync-status" data-phase={status.phase}>
            {status.phase === "syncing"
              ? "Syncing…"
              : status.phase === "error"
                ? status.reason === "offline"
                  ? "Offline — changes are kept here and will sync when the network is back."
                  : (status.error ?? "Sync failed.")
                : pending
                  ? `${pending.toString()} ${pending === 1 ? "change" : "changes"} waiting to sync.`
                  : "Up to date."}
            {status.lastSyncedAt ? (
              <span className="ml-1 text-ink/60">
                Last synced{" "}
                {new Date(status.lastSyncedAt).toLocaleString(undefined, {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                .
              </span>
            ) : null}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || status.phase === "syncing"}
              onClick={() => act(async () => void (await runSync(db)))}
              className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-40"
              data-testid="sync-now"
            >
              Sync now
            </button>
            <button
              type="button"
              aria-expanded={showCode}
              onClick={() => setShowCode(!showCode)}
              className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink"
              data-testid="sync-show-code"
            >
              {showCode ? "Hide pairing code" : "Add a device"}
            </button>
          </div>

          {showCode && link ? (
            <div
              className="mt-3 rounded-crisp border border-hairline p-3"
              data-testid="sync-pairing"
            >
              <p className="text-xs text-ink">
                On the other device, scan this with its camera, or open Settings there and paste the
                code.
              </p>
              <div className="mt-2 flex flex-wrap items-start gap-3">
                <QrCode text={link} />
                <div className="min-w-0 flex-1 basis-48">
                  <p
                    className="break-all rounded-crisp bg-wash p-2 font-mono text-xs text-ink select-all"
                    data-testid="sync-code"
                  >
                    {code}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(code).catch(() => undefined)
                      }
                      className="rounded-pill border border-hairline px-2.5 py-1 text-xs font-medium text-ink"
                    >
                      Copy code
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(link).catch(() => undefined)
                      }
                      className="rounded-pill border border-hairline px-2.5 py-1 text-xs font-medium text-ink"
                    >
                      Copy link
                    </button>
                  </div>
                </div>
              </div>
              <p className="mt-2 rounded-crisp bg-accent-orange/10 p-2 text-xs text-accent-orange-deep">
                This code is the key to your library. Anyone who has it can read and change
                everything in it, so share it only with your own devices. Keep a copy somewhere
                safe: with no account, a library whose every device is lost can only be recovered
                with this code or from an exported archive.
              </p>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => leaveSync(db))}
              className="text-ink underline"
              data-testid="sync-leave"
            >
              Stop syncing on this device
            </button>
            {confirmingDelete ? (
              <span className="flex flex-wrap items-center gap-2 text-ink">
                Delete the synced copy for every device? Each device keeps its own library.
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await deleteSyncedCopy(db);
                      setConfirmingDelete(false);
                    })
                  }
                  className="rounded-pill bg-accent-vermilion-deep px-2.5 py-1 font-medium text-paper"
                  data-testid="sync-confirm-delete"
                >
                  Delete synced copy
                </button>
                <button
                  type="button"
                  className="underline"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-accent-vermilion-deep underline"
                data-testid="sync-delete"
              >
                Delete the synced copy
              </button>
            )}
          </div>
        </>
      )}

      {message ? (
        <p className="mt-2 text-xs text-ink" role="alert" data-testid="sync-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}
