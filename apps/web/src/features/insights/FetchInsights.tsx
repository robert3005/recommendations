/**
 * The place card's way in to hosted review insights (spec/src/reviews.md
 * §Hosted on import): a place with a Google listing and no insights yet gets
 * one button that asks the service to read its reviews. Without an access key
 * on this device the card stays quiet; Settings explains.
 */
import { useState } from "react";
import { nowIso } from "../../lib/time";
import { placeSourceKey } from "./hooks";
import { fetchPlaceInsights, type InsightsTarget, readAccessKey } from "./remote";

export function FetchInsights({ place }: { place: InsightsTarget }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!placeSourceKey(place) || !readAccessKey()) return null;

  const fetchNow = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // On success the card re-renders from the insights store.
      await fetchPlaceInsights(place, { now: nowIso() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4" data-testid="fetch-insights">
      <button
        type="button"
        onClick={() => void fetchNow()}
        disabled={busy}
        className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70 disabled:opacity-60"
      >
        {busy ? "Reading reviews… (up to a minute)" : "Read what reviewers say"}
      </button>
      {error ? (
        <p className="mt-2 text-xs text-ink/70" role="alert" data-testid="fetch-insights-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
