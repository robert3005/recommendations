/**
 * Settings (spec/src/storage.md, spec/src/interop.md §The library archive):
 * the library archive in and out — with the credentials opt-in and its
 * warning — the periodic export reminder, persistent storage, and the
 * provider/privacy disclosure (spec/src/data-sources.md §Privacy).
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import {
  exportArchive,
  importArchiveFile,
  lastArchiveExportAt,
  shouldRemindArchiveExport,
} from "../archive/archive";
import { ImportSection } from "../interop/ImportSection";

export function SettingsPage() {
  const repo = useRepo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [message, setMessage] = useState<string>();

  // The periodic archive reminder (spec/src/storage.md §Eviction honesty).
  const remind = useLiveQuery(() => shouldRemindArchiveExport(repo, nowIso()), [repo]);
  const lastExport = useLiveQuery(() => lastArchiveExportAt(repo), [repo]);

  const doExport = async () => {
    try {
      await exportArchive(repo, { includeCredentials }, nowIso());
      setMessage(
        includeCredentials
          ? "Archive exported — it contains your publish credentials. Treat the file like a password."
          : "Archive exported.",
      );
    } catch (err) {
      setMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const doImport = async (file: File) => {
    try {
      const result = await importArchiveFile(repo, file, nowIso());
      setMessage(
        result.mode === "fresh"
          ? "Library restored."
          : "Merged into the existing library — for the same entity, the newer edit won.",
      );
    } catch (err) {
      setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const requestPersistence = async () => {
    const granted = navigator.storage?.persist ? await navigator.storage.persist() : false;
    setMessage(
      granted
        ? "Persistent storage granted — the browser won't evict your data under pressure."
        : "Persistent storage was not granted; export archives regularly.",
    );
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="settings-page">
      <h1 className="text-xl font-semibold text-ink">Settings</h1>

      <section className="mt-4" id="import">
        <h2 className="text-sm font-semibold text-ink/70">Import</h2>
        <ImportSection />
      </section>

      <section className="mt-4">
        <h2 className="text-sm font-semibold text-ink/70">Library archive</h2>
        <p className="mt-1 text-xs text-ink/60">
          One JSON file of the whole library — places, lists, entries, posts, and publication
          records — preserving every id, so links and post targets survive restore. Your data is
          device-local: this file is the backup and the way to move to another device.
        </p>
        {remind ? (
          <p
            className="mt-2 rounded-crisp bg-accent-orange/10 p-2 text-xs text-accent-orange-deep"
            data-testid="archive-reminder"
          >
            {lastExport
              ? "Your last archive is over a month old — export a fresh one."
              : "You have local data but no archive yet — export one now. Without publish credentials it restores the library but not publish control."}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void doExport()}
            className="rounded-crisp bg-ink px-3 py-1.5 text-sm font-medium text-paper"
            data-testid="export-archive"
          >
            Export archive
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-crisp border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70"
            data-testid="import-archive"
          >
            Import archive…
          </button>
          <label className="flex items-center gap-1 text-xs text-ink/70">
            <input
              type="checkbox"
              checked={includeCredentials}
              onChange={(e) => setIncludeCredentials(e.target.checked)}
              data-testid="include-credentials"
            />
            Include publish credentials
          </label>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Library archive file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void doImport(file);
              e.target.value = "";
            }}
          />
        </div>
        {includeCredentials ? (
          <p
            className="mt-2 rounded-crisp bg-accent-orange/10 p-2 text-xs text-accent-orange-deep"
            data-testid="credentials-warning"
          >
            The file will contain the editor tokens that control your published pages — anyone
            holding it can update or unpublish them. Its name says so; treat it like a password.
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink/60">
            Publish credentials stay out unless you opt in: a routine archive restores the library
            but not the ability to update or unpublish existing pages.
          </p>
        )}
        <p className="mt-2 text-xs text-ink/60">
          Restoring into an empty library is the supported path. Restoring into a non-empty library
          merges by id — same id, same entity, newer edit wins.
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-ink/70">Storage</h2>
        <p className="mt-1 text-xs text-ink/60">
          The library lives in this browser's IndexedDB. Persistent storage asks the browser not to
          evict it under disk pressure.
        </p>
        <button
          type="button"
          onClick={() => void requestPersistence()}
          className="mt-2 rounded-crisp border border-hairline px-3 py-1.5 text-sm font-medium text-ink/70"
        >
          Request persistent storage
        </button>
      </section>

      {message ? (
        <p
          className="mt-4 rounded-crisp bg-ink/5 p-2 text-sm text-ink/70"
          data-testid="settings-message"
        >
          {message}
        </p>
      ) : null}

      <section className="mt-6 text-xs text-ink/60">
        <h2 className="text-sm font-semibold text-ink/70">Data sources</h2>
        <p className="mt-1">
          Map and place data © OpenStreetMap contributors, ODbL. Corrections to public place facts
          belong upstream on openstreetmap.org — the place card links there whenever a place has an
          OSM reference.
        </p>
      </section>

      <section className="mt-6 text-xs text-ink/60">
        <h2 className="text-sm font-semibold text-ink/70">Privacy &amp; what leaves the device</h2>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            <strong>Basemap tiles:</strong> the tile server receives the map area you view as tile
            coordinates, plus ordinary network metadata (IP address, user agent).
          </li>
          <li>
            <strong>Geocoding:</strong> your typed search text — and, during an import, a row's
            Title and Address — go to the geocoder. Pasted map links are parsed on this device and
            never fetched; only an OSM element link triggers a lookup of that element.
          </li>
          <li>
            <strong>Publishing:</strong> the share service receives exactly the documents you
            explicitly publish, and serves them at their public links until you unpublish.
          </li>
          <li>
            <strong>Nothing else leaves the device.</strong> Post bodies and list names never go to
            map or search providers. There are no accounts and no sync; two devices are two
            libraries, and the library archive is what moves one to the other.
          </li>
          <li>
            <strong>Routing &amp; retention:</strong> development builds call public OSM community
            services directly; a production deployment routes requests through proxied endpoints and
            refuses to run against public defaults. Providers keep ordinary server logs under their
            own retention policies; this app keeps no request logs of its own.
          </li>
        </ul>
      </section>
    </div>
  );
}
