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
  const stopPlacing = useUiStore((s) => s.stopPlacingImportItem);
  const placingItemId = useUiStore((s) => s.placingImportItemId);
  const reviewError = useUiStore((s) => s.importReviewError);
  const setReviewError = useUiStore((s) => s.setImportReviewError);
  const clearReviewError = useUiStore((s) => s.clearImportReviewError);
  const setPane = usePaneStore((s) => s.setPane);
  const reviewItems = useReviewItems();
  const [selectedId, setSelectedId] = useState<string>();
  const [candidateChoice, setCandidateChoice] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [busy, setBusy] = useState(false);
  // The first pending item is under review by default; resolving one moves on.
  const items = reviewItems ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [items, selectedId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different review row can share coordinates but must still reset its candidate choice and stale error.
  useEffect(() => {
    setCandidateChoice("");
    setLatitude(selected?.coords?.lat.toString() ?? "");
    setLongitude(selected?.coords?.lng.toString() ?? "");
    clearReviewError();
  }, [clearReviewError, selected?.coords?.lat, selected?.coords?.lng, selected?.id]);
  // Manual placement is route-scoped. Leaving review can never leave a later
  // long-press armed to mutate an import item invisibly.
  useEffect(() => () => stopPlacing(), [stopPlacing]);

  const reportFailure = (itemId: string, error: unknown) => {
    setReviewError(itemId, error instanceof Error ? error.message : String(error));
  };

  const resolve = async (
    itemId: string,
    choice: Parameters<typeof resolveReviewItem>[3],
  ): Promise<void> => {
    setBusy(true);
    clearReviewError();
    try {
      const outcome = await resolveReviewItem(repo, DEPS, itemId, choice, nowIso());
      if (outcome.status === "pending") setReviewError(itemId, outcome.reason);
      if (outcome.status === "resolved") {
        stopPlacing();
        setCandidateChoice("");
      }
    } catch (error) {
      reportFailure(itemId, error);
    } finally {
      setBusy(false);
    }
  };

  useCanvasProjection({ kind: "review", ...(selected ? { itemId: selected.id } : {}) });

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="review-page">
      <h1 className="text-xl font-semibold text-stone-900">Review imported places</h1>
      <p className="mt-1 text-xs text-stone-500">
        Rows that couldn't be placed automatically. The item under review shows its lettered
        candidates on the map — pick one there or here, enter coordinates, place it on the map, or
        skip it.
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
                    <div className="flex items-center gap-1">
                      <select
                        className="rounded border border-stone-300 px-2 py-1 text-xs"
                        value={candidateChoice}
                        aria-label={`Link ${item.raw.title} to a candidate`}
                        data-testid="review-candidates"
                        onChange={(event) => {
                          setCandidateChoice(event.target.value);
                          clearReviewError();
                        }}
                      >
                        <option value="">Link to…</option>
                        {(item.candidates ?? []).map((candidate, index) => (
                          <option
                            key={`${candidate.ref.type}/${candidate.ref.id}`}
                            value={`${candidate.ref.type}/${candidate.ref.id}`}
                          >
                            {String.fromCharCode(65 + index)} — {candidate.name}
                            {candidate.address ? ` — ${candidate.address}` : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 disabled:opacity-40"
                        disabled={busy || candidateChoice === ""}
                        data-testid="review-try-candidate"
                        onClick={() => {
                          const candidate = (item.candidates ?? []).find(
                            (entry) => `${entry.ref.type}/${entry.ref.id}` === candidateChoice,
                          );
                          if (candidate) {
                            void resolve(item.id, { kind: "candidate", ref: candidate.ref });
                          }
                        }}
                      >
                        Try
                      </button>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-1" data-testid="review-coordinate-entry">
                    <input
                      type="number"
                      min="-90"
                      max="90"
                      step="any"
                      value={latitude}
                      onChange={(event) => setLatitude(event.target.value)}
                      aria-label={`Latitude for ${item.raw.title}`}
                      placeholder="Latitude"
                      className="w-24 rounded border border-stone-300 px-2 py-1 text-xs"
                    />
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      step="any"
                      value={longitude}
                      onChange={(event) => setLongitude(event.target.value)}
                      aria-label={`Longitude for ${item.raw.title}`}
                      placeholder="Longitude"
                      className="w-24 rounded border border-stone-300 px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 disabled:opacity-40"
                      disabled={busy || latitude.trim() === "" || longitude.trim() === ""}
                      data-testid="review-place-at-coordinates"
                      onClick={() => {
                        void resolve(item.id, {
                          kind: "coords",
                          lat: Number(latitude),
                          lng: Number(longitude),
                        });
                      }}
                    >
                      Place
                    </button>
                  </div>
                  <button
                    type="button"
                    className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700"
                    data-testid="review-place-on-map"
                    aria-pressed={placingItemId === item.id}
                    onClick={() => {
                      clearReviewError();
                      if (placingItemId === item.id) {
                        stopPlacing();
                      } else {
                        startPlacing(item.id);
                        // Split/half reveals the canvas while keeping the
                        // accessible coordinate and cancel controls present.
                        setPane("split");
                      }
                    }}
                  >
                    {placingItemId === item.id ? "Cancel placement" : "Place on map"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-40"
                    data-testid="review-skip"
                    onClick={() => void resolve(item.id, { kind: "skip" })}
                  >
                    Skip
                  </button>
                  {reviewError?.itemId === item.id ? (
                    <p
                      role="alert"
                      className="basis-full text-xs text-red-700"
                      data-testid="review-error"
                    >
                      {reviewError.message}
                    </p>
                  ) : null}
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
