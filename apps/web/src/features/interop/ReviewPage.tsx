/**
 * The import review queue as a pane route (spec/src/interop.md §Import queue
 * model, 2026-07-19 late): the item under review projects its labelled
 * candidates onto the MAIN map canvas — the bespoke mini map is retired —
 * and manual placement happens on the canvas itself. Candidates stay
 * keyboard-accessible here (the pane is the map's non-map equivalent).
 */
import { useEffect, useState } from "react";
import { useReviewItems } from "../../data/hooks";
import { useDexieRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { poiResolver, searchProvider } from "../../providers";
import { usePaneStore } from "../../state/pane";
import { useCanvasProjection } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { resolveReviewItem } from "./importer";

const DEPS = { search: searchProvider, resolver: poiResolver };

export function ReviewPage() {
  const repo = useDexieRepo();
  const startPlacing = useUiStore((s) => s.startPlacingImportItem);
  const setPane = usePaneStore((s) => s.setPane);
  const reviewItems = useReviewItems();
  const [selectedId, setSelectedId] = useState<string>();
  // The first pending item is under review by default; resolving one moves on.
  const items = reviewItems ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [items, selectedId]);

  useCanvasProjection({ kind: "review", ...(selected ? { itemId: selected.id } : {}) });

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="review-page">
      <h1 className="text-xl font-semibold text-stone-900">Review imported places</h1>
      <p className="mt-1 text-xs text-stone-500">
        Rows that couldn't be placed automatically. The item under review shows its lettered
        candidates on the map — pick one there or here, place it on the map yourself, or skip it.
      </p>
      <ul className="mt-4 space-y-2">
        {items.map((item) => {
          const underReview = selected?.id === item.id;
          return (
            <li
              key={item.id}
              className={`rounded-lg border p-2 ${
                underReview ? "border-stone-400 bg-white shadow-sm" : "border-stone-200 bg-stone-50"
              }`}
              data-testid="review-item"
            >
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => setSelectedId(item.id)}
                aria-pressed={underReview}
              >
                <span className="text-sm font-medium text-stone-900">{item.raw.title}</span>
                {item.raw.address ? (
                  <span className="block text-xs text-stone-500">{item.raw.address}</span>
                ) : null}
              </button>
              {underReview ? (
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
                      {(item.candidates ?? []).map((c, index) => (
                        <option
                          key={`${c.ref.type}/${c.ref.id}`}
                          value={`${c.ref.type}/${c.ref.id}`}
                        >
                          {String.fromCharCode(65 + index)} — {c.name}
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
                      // Manual placement happens on the canvas: reveal it.
                      setPane("collapsed");
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
              ) : null}
            </li>
          );
        })}
        {items.length === 0 ? (
          <li className="py-6 text-sm text-stone-500" data-testid="review-empty">
            Nothing waiting for review. Imports that need a decision will appear here.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
