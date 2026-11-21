/**
 * Settings → Review insights: load the folder the local classify command
 * writes (~/placemarks-data), see what is loaded, clear it. In development, a
 * button attaches sample insights to every place so the card can be seen
 * before a real harvest exists.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { insightsDb } from "./db";
import { clearInsights, loadInsightsFolder, pickedFromFileList } from "./loader";
import { attachSampleInsights } from "./sample";

export function InsightsSection() {
  const repo = useRepo();
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>();
  const counts = useLiveQuery(async () => {
    const db = insightsDb();
    return { places: await db.placeSources.count(), profiles: await db.placeProfiles.count() };
  }, []);

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
        Reviews are classified on your computer with{" "}
        <code className="font-mono">pnpm classify run</code>. Load the data folder here to show the
        results and photos on place cards. Review text is never loaded into the app.
      </p>
      <p className="mt-1 font-mono text-xs text-ink/60" data-testid="insights-counts">
        {counts ? `${counts.places} places · ${counts.profiles} classified` : "…"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-crisp border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70"
          data-testid="load-insights"
        >
          Load data folder…
        </button>
        <button
          type="button"
          onClick={() => void clearInsights().then(() => setMessage("Review insights cleared."))}
          className="rounded-crisp border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70"
          data-testid="clear-insights"
        >
          Clear
        </button>
        {import.meta.env.DEV ? (
          <button
            type="button"
            onClick={() => void attachSamples()}
            className="rounded-crisp border border-dashed border-hairline px-3 py-1.5 text-sm font-medium text-ink/60"
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
