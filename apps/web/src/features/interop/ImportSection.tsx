/**
 * Import places (spec/src/interop.md): drop a Google Takeout archive, CSV,
 * KML/KMZ, GPX, or GeoJSON. Shows the every-row-accounted-for report; rows
 * that need a decision wait in the review queue — its own pane route, where
 * the item under review projects onto the main canvas (2026-07-19 late; the
 * bespoke mini map is retired).
 */

import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useReviewItems } from "../../data/hooks";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { poiResolver, searchProvider } from "../../providers";
import { type ImportReport, runImport } from "./importer";

const DEPS = { search: searchProvider, resolver: poiResolver };

function reportLine(report: ImportReport): string {
  const parts = [
    `${report.placed} placed`,
    ...(report.linked > 0 ? [`${report.linked} linked to OSM`] : []),
    ...(report.duplicates > 0 ? [`${report.duplicates} already present`] : []),
    ...(report.review > 0 ? [`${report.review} to review`] : []),
    ...(report.skipped > 0 ? [`${report.skipped} unusable rows`] : []),
  ];
  return `Imported ${report.fileName}: ${parts.join(", ")}.`;
}

export function ImportSection() {
  const repo = useDexieRepo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const reviewItems = useReviewItems();

  const doImport = async (file: File) => {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = await runImport(repo, { name: file.name, bytes }, DEPS, nowIso());
      setMessage(reportLine(report));
    } catch (err) {
      setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const pending = (reviewItems ?? []).length;

  return (
    <section className="mt-6" data-testid="import-section">
      <h2 className="text-sm font-semibold text-stone-700">Import places</h2>
      <p className="mt-1 text-xs text-stone-500">
        A Google Takeout archive (Saved lists), CSV, KML/KMZ, GPX, or GeoJSON. Parsed on this device
        — nothing is sent to Google. Rows that can't be placed automatically wait in the review
        queue.
      </p>
      <div className="mt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          data-testid="import-places"
        >
          {busy ? "Importing…" : "Import places…"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.csv,.kml,.kmz,.gpx,.json,.geojson"
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
        <p className="mt-2 text-xs text-stone-600" data-testid="import-report">
          {message}
        </p>
      ) : null}
      {pending > 0 ? (
        <p className="mt-2 text-xs" data-testid="import-review">
          <Link
            to="/review"
            className="font-medium text-blue-700 underline"
            data-testid="open-review-queue"
          >
            Review {pending} pending {pending === 1 ? "item" : "items"}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
