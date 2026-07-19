/**
 * Import places (book/src/interop.md): drop a Google Takeout archive, CSV,
 * KML/KMZ, GPX, or GeoJSON. Shows the every-row-accounted-for report and the
 * persisted review queue — candidate pick, place-on-map, or skip.
 */

import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useReviewItems } from "../../data/hooks";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { poiResolver, searchProvider } from "../../providers";
import { useUiStore } from "../../state/ui";
import { type ImportReport, resolveReviewItem, runImport } from "./importer";

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
  const navigate = useNavigate();
  const startPlacing = useUiStore((s) => s.startPlacingImportItem);
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

  return (
    <section className="mt-6" data-testid="import-section">
      <h2 className="text-sm font-semibold text-stone-700">Import places</h2>
      <p className="mt-1 text-xs text-stone-500">
        A Google Takeout archive (Saved lists), CSV, KML/KMZ, GPX, or GeoJSON. Parsed on this device
        — nothing is sent to Google. Rows that can't be placed automatically wait in the review
        queue below.
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

      {(reviewItems ?? []).length > 0 ? (
        <div className="mt-3" data-testid="import-review">
          <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Review queue
          </h3>
          <ul className="mt-2 space-y-2">
            {(reviewItems ?? []).map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-stone-200 bg-stone-50 p-2"
                data-testid="review-item"
              >
                <span className="text-sm font-medium text-stone-900">{item.raw.title}</span>
                {item.raw.address ? (
                  <span className="block text-xs text-stone-500">{item.raw.address}</span>
                ) : null}
                <ReviewMiniMap candidates={item.candidates ?? []} title={item.raw.title} />
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {(item.candidates ?? []).length > 0 ? (
                    <select
                      className="rounded border border-stone-300 px-2 py-1 text-xs"
                      defaultValue=""
                      aria-label={`Link ${item.raw.title} to a candidate`}
                      data-testid="review-candidates"
                      onChange={(e) => {
                        const candidate = (item.candidates ?? []).find(
                          (c) => `${c.ref.type}/${c.ref.id}` === e.target.value,
                        );
                        if (!candidate) return;
                        void resolveReviewItem(
                          repo,
                          DEPS,
                          item.id,
                          { kind: "candidate", ref: candidate.ref },
                          nowIso(),
                        );
                      }}
                    >
                      <option value="">Link to…</option>
                      {(item.candidates ?? []).map((c) => (
                        <option
                          key={`${c.ref.type}/${c.ref.id}`}
                          value={`${c.ref.type}/${c.ref.id}`}
                        >
                          {c.name}
                          {c.address ? ` — ${c.address}` : ""}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button
                    type="button"
                    className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700"
                    data-testid="review-place-on-map"
                    onClick={() => {
                      startPlacing(item.id);
                      void navigate({ to: "/" });
                    }}
                  >
                    Place on map
                  </button>
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
                    data-testid="review-skip"
                    onClick={() => {
                      void resolveReviewItem(repo, DEPS, item.id, { kind: "skip" }, nowIso());
                    }}
                  >
                    Skip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A labelled mini map for ambiguous candidates (book/src/interop.md review):
 * relative positions make "which Central Café?" answerable at a glance without
 * spinning up a full map instance per review row.
 */
function ReviewMiniMap({
  candidates,
  title,
}: {
  candidates: { ref: { type: string; id: string }; name: string; lat: number; lng: number }[];
  title: string;
}) {
  if (candidates.length === 0) return null;
  const lats = candidates.map((c) => c.lat);
  const lngs = candidates.map((c) => c.lng);
  const spanLat = Math.max(Math.max(...lats) - Math.min(...lats), 0.0005);
  const spanLng = Math.max(Math.max(...lngs) - Math.min(...lngs), 0.0005);
  const x = (lng: number) => 8 + ((lng - Math.min(...lngs)) / spanLng) * 104;
  const y = (lat: number) => 8 + ((Math.max(...lats) - lat) / spanLat) * 44;
  return (
    <svg
      role="img"
      aria-label={`Map of candidate locations for ${title}`}
      data-testid="review-mini-map"
      viewBox="0 0 120 60"
      className="mt-1.5 h-[60px] w-[120px] rounded border border-stone-200 bg-white"
    >
      {candidates.map((candidate, index) => (
        <g key={`${candidate.ref.type}/${candidate.ref.id}`}>
          <circle cx={x(candidate.lng)} cy={y(candidate.lat)} r="3" fill="#b45309" />
          <text x={x(candidate.lng) + 5} y={y(candidate.lat) + 3} fontSize="7" fill="#57534e">
            {String.fromCharCode(65 + index)}
          </text>
        </g>
      ))}
    </svg>
  );
}
