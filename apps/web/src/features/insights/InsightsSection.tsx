/**
 * Settings → Review insights (spec/src/reviews.md): the access key for the
 * hosted service, which reads reviews for every imported place with a Google
 * listing; a button for places imported before the key was set; and, for the
 * local pipeline, loading the folder `pnpm classify run` writes. In
 * development, a button attaches sample insights to every place so the card
 * can be seen before a real harvest exists.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { insightsDb } from "./db";
import { clearInsights, loadInsightsFolder, pickedFromFileList } from "./loader";
import {
  placesMissingInsights,
  queueInsights,
  readAccessKey,
  saveAccessKey,
  useInsightsQueue,
} from "./remote";
import { attachSampleInsights } from "./sample";

export function InsightsSection() {
  const repo = useRepo();
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>();
  const queue = useInsightsQueue();
  const [keyDraft, setKeyDraft] = useState(() => readAccessKey() ?? "");
  const counts = useLiveQuery(async () => {
    const db = insightsDb();
    return { places: await db.placeSources.count(), profiles: await db.placeProfiles.count() };
  }, []);
  // Recounted whenever the store changes (a fetch landing) or the queue moves.
  const missing = useLiveQuery(
    async () =>
      (await placesMissingInsights((await repo.listPlaceViews()).map((v) => v.place))).length,
    [repo, counts?.places, queue.done],
  );

  const fetchMissing = async () => {
    const places = await placesMissingInsights((await repo.listPlaceViews()).map((v) => v.place));
    queueInsights(places, nowIso);
  };

  const load = async (files: FileList) => {
    try {
      const r = await loadInsightsFolder(pickedFromFileList(files), nowIso());
      setMessage(
        r.places === 0
          ? "No place folders found. Pick the data folder that contains places/."
          : `Loaded ${r.places} places, ${r.profiles} classified, ${r.photos} photos.${r.skipped.length ? ` Skipped ${r.skipped.length} unreadable folders.` : ""}`,
      );
    } catch (err) {
      setMessage(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const attachSamples = async () => {
    const views = await repo.listPlaceViews();
    const now = nowIso();
    for (const v of views) await attachSampleInsights(v.place.id, now);
    setMessage(`Attached sample insights to ${views.length} places.`);
  };

  return (
    <section className="mt-6" data-testid="insights-settings">
      <h2 className="text-sm font-semibold text-ink/70">Review insights</h2>
      <p className="mt-1 text-xs text-ink/60">
        When you import places with a Google Maps link, the share service reads their newest reviews
        and sends back a summary, scores, dishes and photos for the place card. Review text is never
        stored, here or on the service.
      </p>
      <p className="mt-1 font-mono text-xs text-ink/60" data-testid="insights-counts">
        {counts ? `${counts.places} places · ${counts.profiles} classified` : "…"}
      </p>
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          saveAccessKey(keyDraft);
          setMessage(keyDraft.trim() ? "Access key saved on this device." : "Access key removed.");
        }}
      >
        <label className="text-xs text-ink/70" htmlFor="insights-access-key">
          Access key
        </label>
        <input
          id="insights-access-key"
          type="password"
          autoComplete="off"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder="From the service's INSIGHTS_ACCESS_KEY"
          className="min-w-0 flex-1 rounded-pill border border-hairline bg-transparent px-3 py-1.5 font-mono text-xs"
          data-testid="insights-access-key"
        />
        <button
          type="submit"
          className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70"
        >
          Save
        </button>
      </form>
      {queue.hasKey ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchMissing()}
            disabled={queue.running || !missing}
            className="rounded-pill border border-ink px-3 py-1.5 text-sm font-medium text-ink disabled:border-hairline disabled:text-ink/50"
            data-testid="fetch-missing-insights"
          >
            {missing
              ? `Read reviews for ${missing} ${missing === 1 ? "place" : "places"}`
              : "Every Google place has insights"}
          </button>
          {queue.running || queue.queued > 0 ? (
            <span className="font-mono text-xs text-ink/60" data-testid="insights-queue">
              {queue.done} of {queue.queued} read
              {queue.failed ? ` · ${queue.failed} failed` : ""}
              {queue.running ? " · working…" : ""}
            </span>
          ) : null}
        </div>
      ) : null}
      {queue.error ? (
        <p className="mt-2 text-xs text-ink/70" role="alert" data-testid="insights-queue-error">
          {queue.error}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink/60">
        Or classify on your computer with <code className="font-mono">pnpm classify run</code> and
        load the data folder here.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70"
          data-testid="load-insights"
        >
          Load data folder…
        </button>
        <button
          type="button"
          onClick={() => void clearInsights().then(() => setMessage("Review insights cleared."))}
          className="rounded-pill border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70"
          data-testid="clear-insights"
        >
          Clear
        </button>
        {import.meta.env.DEV ? (
          <button
            type="button"
            onClick={() => void attachSamples()}
            className="rounded-pill border border-dashed border-hairline px-3 py-1.5 text-sm font-medium text-ink/60"
            data-testid="attach-sample-insights"
          >
            Attach sample insights (dev)
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          aria-label="Review insights data folder"
          // Directory picking: Chromium, Firefox and Safari all support webkitdirectory.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          multiple
          onChange={(e) => {
            if (e.target.files?.length) void load(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {message ? (
        <p
          className="mt-2 rounded-crisp bg-ink/5 p-2 text-xs text-ink/70"
          data-testid="insights-message"
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}
