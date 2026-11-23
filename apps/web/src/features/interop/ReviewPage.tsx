/**
 * The import review queue (spec/src/interop.md §The review queue): a notebook
 * route; the item under review projects onto the canvas with its candidates
 * as labelled pins. Picking a candidate places the row with that result's
 * facts and records its osmRef; manual placement is clicking the map (user
 * coordinates, no osmRef); a row can be skipped. A geocoder-paused batch
 * offers a retry — those rows are not misses.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { geocoder } from "../../providers";
import { paneCovered, usePaneStore } from "../../state/pane";
import { useCanvasProjection, useProjectionStore } from "../../state/projection";
import {
  type ConflictResolution,
  isGeocodePending,
  listReviewItems,
  type ReviewChoice,
  resolveReviewItem,
  resumeImport,
} from "./importer";

export function ReviewPage() {
  const repo = useRepo();
  const setImportItemHandler = useProjectionStore((s) => s.setImportItemHandler);
  const paneMode = usePaneStore((s) => s.mode);
  const paneSheet = usePaneStore((s) => s.sheet);
  const collapse = usePaneStore((s) => s.collapse);
  const queue = useLiveQuery(() => listReviewItems(repo), [repo]);
  const [selectedId, setSelectedId] = useState<string>();
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<{ itemId: string; message: string }>();
  /** Map clicks place the item only while explicitly armed. */
  const [placing, setPlacing] = useState(false);
  // A name+proximity match prompts instead of merging silently: the pending
  // choice waits here until the user picks "use existing" or "keep both".
  const [conflict, setConflict] = useState<{
    itemId: string;
    choice: Exclude<ReviewChoice, { kind: "skip" }>;
    existingId: string;
    existingName: string;
  }>();

  // The first pending item is under review by default; resolving one moves on.
  const items = queue ?? [];
  const pendingGeocode = items.filter(({ item }) => isGeocodePending(item)).length;
  const selected = items.find(({ item }) => item.id === selectedId) ?? items[0];
  const selectedItem = selected?.item;
  useEffect(() => {
    if (selectedId && !items.some(({ item }) => item.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [items, selectedId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different review row can share coordinates but must still reset its candidate choice and stale state.
  useEffect(() => {
    setLatitude(selectedItem?.coords?.lat.toString() ?? "");
    setLongitude(selectedItem?.coords?.lng.toString() ?? "");
    setConflict(undefined);
    setPlacing(false);
    setError(undefined);
  }, [selectedItem?.coords?.lat, selectedItem?.coords?.lng, selectedItem?.id]);

  const resolve = useCallback(
    async (
      itemId: string,
      choice: ReviewChoice,
      resolution?: ConflictResolution,
    ): Promise<void> => {
      setBusy(true);
      setError(undefined);
      setMessage(undefined);
      try {
        const applied =
          resolution && choice.kind !== "skip" ? { ...choice, conflict: resolution } : choice;
        const outcome = await resolveReviewItem(repo, itemId, applied, nowIso());
        if (outcome.status === "pending") setError({ itemId, message: outcome.reason });
        if (outcome.status === "conflict") {
          setConflict({
            itemId,
            choice: applied as Exclude<ReviewChoice, { kind: "skip" }>,
            existingId: outcome.existing.id,
            existingName: outcome.existing.name,
          });
        }
        if (outcome.status === "resolved") {
          setConflict(undefined);
          setPlacing(false);
          if (outcome.droppedNote) {
            setMessage("Placed. Its note was dropped — the place already has a post.");
          }
        }
      } catch (err) {
        setError({ itemId, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
      }
    },
    [repo],
  );

  // The canvas hands candidate pin taps and manual-placement clicks back here
  // while this route is mounted (state/projection.ts ImportItemPick).
  useEffect(() => {
    if (!selectedItem) {
      setImportItemHandler(null);
      return;
    }
    const itemId = selectedItem.id;
    setImportItemHandler((pick) => {
      if (pick.kind === "candidate") {
        void resolve(itemId, { kind: "candidate", index: Number(pick.key) });
      } else if (placing) {
        void resolve(itemId, { kind: "coords", lat: pick.lat, lng: pick.lng });
      }
    });
    return () => setImportItemHandler(null);
  }, [selectedItem, placing, resolve, setImportItemHandler]);

  const retryGeocoding = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await resumeImport(repo, { geocoder }, nowIso());
      setMessage(
        result.geocodePending > 0
          ? `Geocoder still unreachable — ${result.geocodePending.toString()} rows will retry.`
          : `Retried: ${(result.placed + result.alreadyPresent).toString()} placed, ${result.review.toString()} to review.`,
      );
    } finally {
      setBusy(false);
    }
  };

  useCanvasProjection(
    selectedItem
      ? {
          kind: "import-item",
          itemId: selectedItem.id,
          title: selectedItem.raw.title,
          ...(selectedItem.coords ? { coords: selectedItem.coords } : {}),
          candidates: (selectedItem.candidates ?? []).map((candidate, index) => ({
            key: index.toString(),
            name: candidate.name,
            lat: candidate.lat,
            lng: candidate.lng,
          })),
        }
      : { kind: "lists-overlay" },
  );

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="review-page">
      <h1 className="text-xl font-semibold text-ink">Review imported places</h1>
      <p className="mt-1 text-xs text-ink/60">
        Rows that couldn't be placed automatically. The item under review shows its lettered
        candidates on the map — pick one there or here, enter coordinates, place it on the map, or
        skip it.
      </p>
      {pendingGeocode > 0 ? (
        <p
          className="mt-2 flex items-center gap-2 text-xs text-ink/70"
          data-testid="review-pending-geocode"
        >
          {pendingGeocode} {pendingGeocode === 1 ? "row is" : "rows are"} waiting on the geocoder.
          <button
            type="button"
            disabled={busy}
            className="rounded-pill border border-hairline px-2 py-1 font-medium text-ink/70 disabled:opacity-40"
            data-testid="review-retry-geocoding"
            onClick={() => void retryGeocoding()}
          >
            Retry geocoding
          </button>
        </p>
      ) : null}
      {message ? (
        <p className="mt-2 text-xs text-ink/70" data-testid="review-message">
          {message}
        </p>
      ) : null}
      <ul className="mt-4 space-y-2">
        {items.map(({ item }) => {
          const underReview = selectedItem?.id === item.id;
          return (
            <li
              key={item.id}
              className={`rounded-crisp border p-2 ${
                underReview ? "border-ink/30 bg-paper shadow-sm" : "border-hairline bg-ink/5"
              }`}
              data-testid="review-item"
            >
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => setSelectedId(item.id)}
                aria-pressed={underReview}
              >
                <span className="text-sm font-medium text-ink">{item.raw.title}</span>
                {item.raw.address ? (
                  <span className="block text-xs text-ink/60">{item.raw.address}</span>
                ) : null}
                {isGeocodePending(item) ? (
                  <span className="block text-xs text-ink/60">Waiting on the geocoder</span>
                ) : null}
              </button>
              {underReview ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {(item.candidates ?? []).length > 0 ? (
                    // Each candidate is one press, with its address in full:
                    // the choice is usually made on the address.
                    <ul
                      className="w-full space-y-1"
                      aria-label={`Candidates for ${item.raw.title}`}
                      data-testid="review-candidates"
                    >
                      {(item.candidates ?? []).map((candidate, index) => (
                        <li key={`${index.toString()}-${candidate.name}`}>
                          <button
                            type="button"
                            disabled={busy}
                            className="flex w-full items-baseline gap-2 rounded-crisp border border-hairline px-2 py-1 text-left text-xs hover:bg-hover disabled:opacity-40"
                            data-testid="review-try-candidate"
                            onClick={() => void resolve(item.id, { kind: "candidate", index })}
                          >
                            <span className="font-mono font-medium text-ink">
                              {String.fromCharCode(65 + index)}
                            </span>
                            <span className="min-w-0">
                              <span className="font-medium text-ink">{candidate.name}</span>
                              {candidate.address ? (
                                <span className="block text-ink/60">{candidate.address}</span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
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
                      className="w-24 rounded-pill border border-hairline px-2 py-1 text-xs"
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
                      className="w-24 rounded-pill border border-hairline px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      className="rounded-pill border border-hairline px-2 py-1 text-xs font-medium text-ink/70 disabled:opacity-40"
                      disabled={busy || latitude.trim() === "" || longitude.trim() === ""}
                      data-testid="review-place-at-coordinates"
                      onClick={() =>
                        void resolve(item.id, {
                          kind: "coords",
                          lat: Number(latitude),
                          lng: Number(longitude),
                        })
                      }
                    >
                      Place
                    </button>
                  </div>
                  <button
                    type="button"
                    className="rounded-pill border border-hairline px-2 py-1 text-xs font-medium text-ink/70"
                    data-testid="review-place-on-map"
                    aria-pressed={placing}
                    onClick={() => {
                      setError(undefined);
                      if (placing) {
                        setPlacing(false);
                      } else {
                        setPlacing(true);
                        // Reveal the canvas while keeping the accessible
                        // coordinate and cancel controls present.
                        if (paneCovered({ mode: paneMode, sheet: paneSheet })) collapse();
                      }
                    }}
                  >
                    {placing ? "Cancel placement" : "Place on map"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-pill px-2 py-1 text-xs text-ink/60 hover:bg-hover disabled:opacity-40"
                    data-testid="review-skip"
                    onClick={() => void resolve(item.id, { kind: "skip" })}
                  >
                    Skip
                  </button>
                  {conflict?.itemId === item.id ? (
                    <div
                      className="basis-full rounded-crisp border border-hairline bg-ink/5 p-2 text-xs"
                      data-testid="review-conflict"
                    >
                      <p className="text-ink/70">
                        “{conflict.existingName}” is already in the library nearby.
                      </p>
                      <div className="mt-1 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-pill border border-hairline px-2 py-1 font-medium text-ink/70 disabled:opacity-40"
                          data-testid="review-conflict-use-existing"
                          onClick={() =>
                            void resolve(item.id, conflict.choice, {
                              kind: "use-existing",
                              placeId: conflict.existingId,
                            })
                          }
                        >
                          Use the existing place
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-pill border border-hairline px-2 py-1 font-medium text-ink/70 disabled:opacity-40"
                          data-testid="review-conflict-force-new"
                          onClick={() =>
                            void resolve(item.id, conflict.choice, { kind: "force-new" })
                          }
                        >
                          Keep both
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {error?.itemId === item.id ? (
                    <p
                      role="alert"
                      className="basis-full text-xs text-accent-vermilion-deep"
                      data-testid="review-error"
                    >
                      {error.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
        {items.length === 0 ? (
          <li className="py-6 text-sm text-ink/60" data-testid="review-empty">
            Nothing waiting for review. Imports that need a decision will appear here.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
