/**
 * Import places (spec/src/interop.md §Import): drop a Google Takeout archive
 * (or one of its pieces — a Saved list CSV, Saved Places.json) or a My Maps
 * KML/KMZ. Parsed on this device — nothing is sent to Google. Shows the
 * every-row-accounted-for report; rows that need a decision wait in the
 * review queue, its own pane route projecting onto the canvas.
 */
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { geocoder } from "../../providers";
import { queueMissingInsights } from "../insights/remote";
import { type ImportReport, listReviewItems, runImport } from "./importer";

function reportLine(report: ImportReport): string {
  const parts = [
    `${report.placed} placed`,
    ...(report.alreadyPresent > 0 ? [`${report.alreadyPresent} already present`] : []),
    ...(report.review > 0 ? [`${report.review} to review`] : []),
    ...(report.geocodePending > 0 ? [`${report.geocodePending} waiting on the geocoder`] : []),
    ...(report.skipped > 0 ? [`${report.skipped} unusable rows`] : []),
    ...(report.droppedNotes > 0
      ? [`${report.droppedNotes} notes dropped (place already has a different note)`]
      : []),
  ];
  return `Imported ${report.fileName} (${report.rows} rows): ${parts.join(", ")}.`;
}

export function ImportSection() {
  const repo = useRepo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const queue = useLiveQuery(() => listReviewItems(repo), [repo]);

  const doImport = async (file: File) => {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = await runImport(
        repo,
        { name: file.name, bytes },
        { geocoder, onProgress: (done, total) => setProgress({ done, total }) },
        nowIso(),
      );
      setMessage(reportLine(report));
      // Hosted review insights for the newly placed Google places (no key: nothing happens).
      void queueMissingInsights(repo, nowIso).catch(() => undefined);
    } catch (err) {
      setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  const pending = (queue ?? []).length;

  return (
    <section className="mt-6" data-testid="import-section">
      <h2 className="text-sm font-semibold text-ink/70">Import places</h2>
      <p className="mt-1 text-xs text-ink/60">
        A Google Takeout archive (Saved lists), a single Saved list CSV, Saved Places.json, or a My
        Maps KML/KMZ. Parsed on this device — nothing is sent to Google. Rows that can't be placed
        automatically wait in the review queue.
      </p>
      <div className="mt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="rounded-pill bg-ink px-3 py-1.5 text-sm font-medium text-paper disabled:opacity-40"
          data-testid="import-places"
        >
          {busy
            ? progress && progress.total > 0
              ? `Importing… ${progress.done} of ${progress.total}`
              : "Importing…"
            : "Import places…"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.csv,.kml,.kmz,.json"
          className="hidden"
          aria-label="Import places file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void doImport(file);
            e.target.value = "";
          }}
        />
      </div>
      {message ? (
        <p className="mt-2 text-xs text-ink/70" data-testid="import-report">
          {message}
        </p>
      ) : null}
      {pending > 0 ? (
        <p className="mt-2 text-xs" data-testid="import-review">
          <Link
            to="/review"
            className="font-medium text-accent-cobalt-deep underline"
            data-testid="open-review-queue"
          >
            Review {pending} pending {pending === 1 ? "item" : "items"}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
